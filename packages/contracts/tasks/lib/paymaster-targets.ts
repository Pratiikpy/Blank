// Contracts a BlankAccount calls from the app, by deployments-JSON key.
// BlankPaymaster sponsors only execute / executeBatch to approved targets,
// so this list and the app have to agree. setup-aa and
// wire-paymaster-targets both read it.
//
// Never listed: the account itself. Account settings changes target the
// sender, which no global allowlist can name. BlankPaymaster sponsors exactly
// three of them, with arguments from SELF_ADMIN_APPROVALS below.
export const PAYMASTER_TARGETS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "FHERC20Vault_USDC", label: "FHERC20Vault USDC (shield/unshield)" },
  { key: "FHERC20Vault_USDT", label: "FHERC20Vault USDT" },
  { key: "TestUSDC", label: "TestUSDC (faucet/approve, scheduled sends)" },
  { key: "TestUSDT", label: "TestUSDT" },
  { key: "PaymentHub", label: "PaymentHub" },
  { key: "BusinessHub", label: "BusinessHub" },
  { key: "EncryptedEscrow", label: "EncryptedEscrow" },
  { key: "InvoiceApprovalResolver", label: "InvoiceApprovalResolver" },
  { key: "GroupManager", label: "GroupManager" },
  { key: "CreatorHub", label: "CreatorHub" },
  // createOffer/fillOffer are retired, cancelOffer still lets makers exit.
  { key: "P2PExchange", label: "P2PExchange (cancel only)" },
  { key: "P2POfframp", label: "P2POfframp" },
  { key: "GiftMoney", label: "GiftMoney" },
  { key: "StealthPayments", label: "StealthPayments" },
  { key: "ERC6538Registry", label: "ERC-6538 registry (stealth meta-address)" },
  { key: "ERC5564Announcer", label: "ERC-5564 announcer" },
  { key: "InheritanceManager", label: "InheritanceManager" },
  { key: "PrivacyRouter", label: "PrivacyRouter" },
  { key: "PaymentReceipts", label: "PaymentReceipts" },
  { key: "EncryptedFlags", label: "EncryptedFlags" },
  { key: "ClaimLinks", label: "ClaimLinks" },
  { key: "Storefront", label: "Storefront" },
  { key: "EncryptedCrowdfund", label: "EncryptedCrowdfund" },
  { key: "BurnerRegistry", label: "BurnerRegistry" },
  { key: "BlankHandles", label: "BlankHandles" },
  { key: "GuardianModule", label: "GuardianModule (guardians, recovery votes)" },
  { key: "SessionKeyValidator", label: "SessionKeyValidator (setScope/revokeScope)" },
];

// Retired on-chain: every write reverts, so sponsoring them only burns the
// deposit. wire-paymaster-targets un-approves them. Old addresses kept under
// *_v0 after a fresh deploy are retired too.
export const RETIRED_TARGETS: ReadonlyArray<string> = [
  "ProofOfBalance",
  "SessionKeyValidator_v0",
  "InvoiceApprovalResolver_v0",
  "BurnerRegistry_v0",
];

// Self-calls BlankPaymaster sponsors, by deployments-JSON key:
//   upgradeToAndCall(impl, "")   impl  in approvedImplementations
//   enableValidator(v)           v     in approvedValidators
//   setRecoveryModule(m)         m     in approvedRecoveryModules
// The factory's implementation is immutable, so new accounts start on the
// old one and must upgrade themselves; these let them do it without ETH.
export type SelfAdminKind = "implementation" | "validator" | "recoveryModule";
export const SELF_ADMIN_APPROVALS: ReadonlyArray<{ key: string; kind: SelfAdminKind }> = [
  { key: "BlankAccount_Impl_security_v1", kind: "implementation" },
  { key: "SessionKeyValidator", kind: "validator" },
  { key: "GuardianModule", kind: "recoveryModule" },
];
// Superseded addresses: revoked if still approved.
export const RETIRED_SELF_ADMIN: ReadonlyArray<{ key: string; kind: SelfAdminKind }> = [
  { key: "SessionKeyValidator_v0", kind: "validator" },
];

export const SELF_ADMIN_ABI = [
  "function approvedImplementations(address) view returns (bool)",
  "function approvedValidators(address) view returns (bool)",
  "function approvedRecoveryModules(address) view returns (bool)",
  "function setApprovedImplementation(address implementation, bool approved)",
  "function setApprovedValidator(address validator, bool approved)",
  "function setApprovedRecoveryModule(address module, bool approved)",
];

const VIEW: Record<SelfAdminKind, string> = {
  implementation: "approvedImplementations",
  validator: "approvedValidators",
  recoveryModule: "approvedRecoveryModules",
};
const SETTER: Record<SelfAdminKind, string> = {
  implementation: "setApprovedImplementation",
  validator: "setApprovedValidator",
  recoveryModule: "setApprovedRecoveryModule",
};

/** Bring the paymaster's self-call approvals in line with the deployment
 *  file. `paymaster` must be connected with SELF_ADMIN_ABI (and a signer
 *  that owns it unless dryRun). Returns the number of changes. */
export async function wireSelfAdminApprovals(
  paymaster: { [k: string]: any },
  deployments: Record<string, unknown>,
  opts: { dryRun?: boolean; log?: (s: string) => void; confirmations?: number } = {},
): Promise<number> {
  const log = opts.log ?? console.log;
  const changes: Array<{ key: string; kind: SelfAdminKind; addr: string; approve: boolean }> = [];
  const live = new Set<string>();
  for (const { key, kind } of SELF_ADMIN_APPROVALS) {
    const addr = deployments[key];
    if (typeof addr !== "string") {
      log(`  skip:     ${key} (not in deployments)`);
      continue;
    }
    live.add(addr.toLowerCase());
    const ok: boolean = await paymaster[VIEW[kind]](addr);
    log(`  ${ok ? "ok:      " : "missing: "} ${kind.padEnd(15)} ${key.padEnd(30)} ${addr}`);
    if (!ok) changes.push({ key, kind, addr, approve: true });
  }
  for (const { key, kind } of RETIRED_SELF_ADMIN) {
    const addr = deployments[key];
    if (typeof addr !== "string" || live.has(addr.toLowerCase())) continue;
    if (await paymaster[VIEW[kind]](addr)) {
      log(`  retired:  ${kind.padEnd(15)} ${key.padEnd(30)} ${addr} (will revoke)`);
      changes.push({ key, kind, addr, approve: false });
    }
  }
  if (opts.dryRun) return changes.length;
  for (const c of changes) {
    const tx = await paymaster[SETTER[c.kind]](c.addr, c.approve);
    log(`  ${c.approve ? "approve" : "revoke "} ${c.key} -> tx ${tx.hash}`);
    const rcpt = await tx.wait(opts.confirmations ?? 2);
    if (rcpt?.status !== 1) throw new Error(`${SETTER[c.kind]}(${c.key}) reverted: ${tx.hash}`);
  }
  return changes.length;
}
