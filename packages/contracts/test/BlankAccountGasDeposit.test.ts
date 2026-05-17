import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// ══════════════════════════════════════════════════════════════════
//  BlankAccount gas-wallet UUPS upgrade — receive() auto-deposit,
//  topUpGas, withdrawGasDepositTo.
//
//  This unlocks the "deposit ETH from anywhere → automatic gas
//  credit" UX. Without these hooks, a user who sends ETH from a CEX
//  withdrawal or a hardware wallet to their smart-account address
//  would see the ETH sit idle (EntryPoint doesn't see it), and would
//  need a separate "convert to gas" UserOp paid by the paymaster.
//  With them, any plain ETH transfer auto-credits gas.
//
//  Pinned invariants:
//   • receive() auto-deposits incoming ETH to EntryPoint
//   • Auto-deposit is skipped when msg.sender == EntryPoint (recursion
//     guard against non-canonical EntryPoints that refund via plain
//     transfer)
//   • If depositTo reverts (defensive try/catch), ETH stays as idle
//     balance — never lost
//   • topUpGas is permissionless and converts ALL idle ETH to deposit
//   • withdrawGasDepositTo is gated to self-or-EntryPoint and pulls
//     from the EntryPoint deposit map (NOT the idle balance)
//   • Zero-value receive() is a no-op (no wasted gas, no log noise)
// ══════════════════════════════════════════════════════════════════

async function fixture() {
  const [funder, recipient, attacker] = await hre.ethers.getSigners();

  const EntryPoint = await hre.ethers.getContractFactory(
    "@account-abstraction/contracts/core/EntryPoint.sol:EntryPoint",
  );
  const entryPoint = await EntryPoint.deploy();
  await entryPoint.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("BlankAccountFactory");
  const factory = await Factory.deploy(await entryPoint.getAddress());
  await factory.waitForDeployment();

  const ownerX = 12345n;
  const ownerY = 67890n;
  const recoveryModule = hre.ethers.ZeroAddress;
  const salt = 1n;
  await factory.createAccount(ownerX, ownerY, recoveryModule, salt);
  const accountAddr = await factory["getAddress(uint256,uint256,address,uint256)"](
    ownerX,
    ownerY,
    recoveryModule,
    salt,
  );
  const account = await hre.ethers.getContractAt("BlankAccount", accountAddr);

  return { funder, recipient, attacker, entryPoint, factory, account, accountAddr };
}

describe("BlankAccount — receive() auto-deposit", () => {
  it("plain ETH transfer auto-deposits the full value to EntryPoint", async () => {
    const { funder, entryPoint, accountAddr } = await loadFixture(fixture);
    const amount = hre.ethers.parseEther("0.05");

    expect(await entryPoint.balanceOf(accountAddr)).to.equal(0n);
    await funder.sendTransaction({ to: accountAddr, value: amount });

    expect(await entryPoint.balanceOf(accountAddr)).to.equal(amount);
    // Idle balance on the account itself is zero — every wei went to deposit.
    expect(await hre.ethers.provider.getBalance(accountAddr)).to.equal(0n);
  });

  it("multiple deposits accumulate (no overwrite)", async () => {
    const { funder, entryPoint, accountAddr } = await loadFixture(fixture);
    await funder.sendTransaction({ to: accountAddr, value: hre.ethers.parseEther("0.03") });
    await funder.sendTransaction({ to: accountAddr, value: hre.ethers.parseEther("0.07") });
    expect(await entryPoint.balanceOf(accountAddr)).to.equal(hre.ethers.parseEther("0.10"));
  });

  it("zero-value transfer is a no-op (no deposit, no revert)", async () => {
    const { funder, entryPoint, accountAddr } = await loadFixture(fixture);
    // Send a zero-value tx that triggers receive().
    await funder.sendTransaction({ to: accountAddr, value: 0n });
    expect(await entryPoint.balanceOf(accountAddr)).to.equal(0n);
  });

  it("CRITICAL: skips auto-deposit when msg.sender == EntryPoint (recursion guard)", async () => {
    const { entryPoint, accountAddr } = await loadFixture(fixture);
    const epAddr = await entryPoint.getAddress();
    await hre.ethers.provider.send("hardhat_impersonateAccount", [epAddr]);
    await hre.ethers.provider.send("hardhat_setBalance", [epAddr, "0x10000000000000000000"]);
    const epSigner = await hre.ethers.getSigner(epAddr);

    // EntryPoint sends ETH directly to the account (simulating a non-canonical
    // refund path). Auto-deposit should NOT fire — would loop infinitely on a
    // real bad implementation. Instead the ETH stays as idle balance.
    await epSigner.sendTransaction({
      to: accountAddr,
      value: hre.ethers.parseEther("0.01"),
    });

    expect(await entryPoint.balanceOf(accountAddr)).to.equal(0n);
    expect(await hre.ethers.provider.getBalance(accountAddr)).to.equal(
      hre.ethers.parseEther("0.01"),
    );

    await hre.ethers.provider.send("hardhat_stopImpersonatingAccount", [epAddr]);
  });
});

describe("BlankAccount — topUpGas manual fallback", () => {
  it("converts idle balance into EntryPoint deposit (permissionless)", async () => {
    const { entryPoint, account, accountAddr, attacker } = await loadFixture(fixture);

    // Plant idle ETH on the account WITHOUT triggering receive() — use the
    // EntryPoint impersonation path (recursion guard leaves ETH idle).
    const epAddr = await entryPoint.getAddress();
    await hre.ethers.provider.send("hardhat_impersonateAccount", [epAddr]);
    await hre.ethers.provider.send("hardhat_setBalance", [epAddr, "0x10000000000000000000"]);
    const epSigner = await hre.ethers.getSigner(epAddr);
    await epSigner.sendTransaction({
      to: accountAddr,
      value: hre.ethers.parseEther("0.02"),
    });
    await hre.ethers.provider.send("hardhat_stopImpersonatingAccount", [epAddr]);

    expect(await hre.ethers.provider.getBalance(accountAddr)).to.equal(
      hre.ethers.parseEther("0.02"),
    );
    expect(await entryPoint.balanceOf(accountAddr)).to.equal(0n);

    // Anyone (including a random attacker) can call topUpGas — it only ever
    // benefits the account owner so there's no auth gate.
    await account.connect(attacker).topUpGas();

    expect(await entryPoint.balanceOf(accountAddr)).to.equal(
      hre.ethers.parseEther("0.02"),
    );
    expect(await hre.ethers.provider.getBalance(accountAddr)).to.equal(0n);
  });

  it("topUpGas on empty balance is a no-op (no revert)", async () => {
    const { account } = await loadFixture(fixture);
    await expect(account.topUpGas()).to.not.be.reverted;
  });
});

describe("BlankAccount — withdrawGasDepositTo", () => {
  it("withdraws deposited gas to an arbitrary recipient (when called from EntryPoint)", async () => {
    const { funder, entryPoint, accountAddr, recipient } = await loadFixture(fixture);

    // Fund the account first via receive() auto-deposit.
    await funder.sendTransaction({
      to: accountAddr,
      value: hre.ethers.parseEther("0.1"),
    });
    expect(await entryPoint.balanceOf(accountAddr)).to.equal(
      hre.ethers.parseEther("0.1"),
    );

    // Withdraw via EntryPoint impersonation (simulates a UserOp self-call).
    const epAddr = await entryPoint.getAddress();
    await hre.ethers.provider.send("hardhat_impersonateAccount", [epAddr]);
    await hre.ethers.provider.send("hardhat_setBalance", [epAddr, "0x10000000000000000000"]);
    const epSigner = await hre.ethers.getSigner(epAddr);

    const account = await hre.ethers.getContractAt("BlankAccount", accountAddr);
    const recipientBefore = await hre.ethers.provider.getBalance(recipient.address);
    await account
      .connect(epSigner)
      .withdrawGasDepositTo(recipient.address, hre.ethers.parseEther("0.05"));
    const recipientAfter = await hre.ethers.provider.getBalance(recipient.address);

    expect(recipientAfter - recipientBefore).to.equal(hre.ethers.parseEther("0.05"));
    expect(await entryPoint.balanceOf(accountAddr)).to.equal(
      hre.ethers.parseEther("0.05"),
    );

    await hre.ethers.provider.send("hardhat_stopImpersonatingAccount", [epAddr]);
  });

  it("CRITICAL: external EOA cannot drain gas deposit (onlySelfOrEntryPoint)", async () => {
    const { funder, entryPoint, accountAddr, attacker, recipient } = await loadFixture(fixture);
    await funder.sendTransaction({
      to: accountAddr,
      value: hre.ethers.parseEther("0.1"),
    });
    expect(await entryPoint.balanceOf(accountAddr)).to.equal(
      hre.ethers.parseEther("0.1"),
    );

    const account = await hre.ethers.getContractAt("BlankAccount", accountAddr);
    await expect(
      account
        .connect(attacker)
        .withdrawGasDepositTo(recipient.address, hre.ethers.parseEther("0.1")),
    ).to.be.revertedWith("BlankAccount: unauthorized");
  });
});

describe("BlankAccount — gas-wallet integration with paymaster path", () => {
  it("a fresh account starts with zero deposit (sender-paid path requires explicit funding)", async () => {
    const { entryPoint, accountAddr } = await loadFixture(fixture);
    expect(await entryPoint.balanceOf(accountAddr)).to.equal(0n);
  });

  it("after one receive() + one topUpGas + one withdraw cycle, balances reconcile", async () => {
    const { funder, entryPoint, accountAddr, recipient } = await loadFixture(fixture);

    // Step 1: deposit 0.1 ETH via receive() (auto).
    await funder.sendTransaction({
      to: accountAddr,
      value: hre.ethers.parseEther("0.1"),
    });
    // Step 2: send another 0.05 ETH from EntryPoint (lands as idle via the
    // recursion guard).
    const epAddr = await entryPoint.getAddress();
    await hre.ethers.provider.send("hardhat_impersonateAccount", [epAddr]);
    await hre.ethers.provider.send("hardhat_setBalance", [epAddr, "0x10000000000000000000"]);
    const epSigner = await hre.ethers.getSigner(epAddr);
    await epSigner.sendTransaction({
      to: accountAddr,
      value: hre.ethers.parseEther("0.05"),
    });
    // Step 3: topUpGas picks it up.
    const account = await hre.ethers.getContractAt("BlankAccount", accountAddr);
    await account.topUpGas();
    expect(await entryPoint.balanceOf(accountAddr)).to.equal(
      hre.ethers.parseEther("0.15"),
    );
    // Step 4: withdraw half from the deposit map (called via EntryPoint).
    await account
      .connect(epSigner)
      .withdrawGasDepositTo(recipient.address, hre.ethers.parseEther("0.075"));
    expect(await entryPoint.balanceOf(accountAddr)).to.equal(
      hre.ethers.parseEther("0.075"),
    );
    await hre.ethers.provider.send("hardhat_stopImpersonatingAccount", [epAddr]);
  });
});
