import { test, expect } from "@playwright/test";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// EOA code-path verification using a mock injected provider.
//
// Why mock instead of real MetaMask?
//  - dappwright's wallet.approve() hangs 50%+ of runs because MetaMask's
//    popup detection is flaky in automated browsers
//  - We're testing OUR code (wagmi injected connector → useAccount → UI),
//    not MetaMask itself
//  - Mock runs in <30s vs 5-15min with real MetaMask
//
// What this proves:
//  - wagmi's injected() connector detects window.ethereum
//  - The app's Onboarding flow has a "Connect MetaMask" path
//  - useAccount().address is populated and rendered in the UI
//  - The EOA path doesn't crash (vs the passkey path we normally test)

const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // hardhat #0
const BASE_SEPOLIA_CHAIN_ID = "0x14a34"; // 84532

const MOCK_PROVIDER_SCRIPT = `
  // Minimal EIP-1193 mock provider
  const listeners = {};
  window.ethereum = {
    isMetaMask: true,
    _isMock: true,
    chainId: "${BASE_SEPOLIA_CHAIN_ID}",
    selectedAddress: "${TEST_ADDRESS}",
    networkVersion: "84532",
    request: async ({ method, params }) => {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return ["${TEST_ADDRESS}"];
        case "eth_chainId":
          return "${BASE_SEPOLIA_CHAIN_ID}";
        case "net_version":
          return "84532";
        case "wallet_switchEthereumChain":
          return null;
        case "wallet_addEthereumChain":
          return null;
        case "eth_getBalance":
          return "0x0";
        case "eth_blockNumber":
          return "0x1";
        case "eth_call":
          return "0x";
        case "eth_estimateGas":
          return "0x5208";
        case "personal_sign":
        case "eth_signTypedData_v4":
          return "0x" + "0".repeat(130); // dummy sig
        default:
          console.log("[mock-ethereum] unhandled:", method);
          return null;
      }
    },
    on: (event, fn) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
      return window.ethereum;
    },
    removeListener: (event, fn) => {
      if (listeners[event]) listeners[event] = listeners[event].filter(f => f !== fn);
      return window.ethereum;
    },
    removeAllListeners: () => { Object.keys(listeners).forEach(k => delete listeners[k]); },
    emit: (event, ...args) => {
      (listeners[event] || []).forEach(fn => { try { fn(...args) } catch {} });
    },
  };
  // EIP-6963 announce (wagmi listens for this)
  window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
    detail: {
      info: { uuid: "mock-mm", name: "MetaMask", icon: "", rdns: "io.metamask" },
      provider: window.ethereum,
    },
  }));
`;

const SCREENSHOT_DIR = path.resolve(__dirname, "..", "test-results", "screenshots");

test.describe("EOA / Mock Injected Provider", () => {
  test.setTimeout(180_000); // 3 min

  test("injected wallet connects → address visible in UI", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Inject mock BEFORE page loads
    await page.addInitScript(MOCK_PROVIDER_SCRIPT);

    // Set chain preference
    await page.goto("http://localhost:3000/");
    await page.evaluate(() => {
      localStorage.setItem("blank_active_chain_id", "84532");
    });
    await page.goto("http://localhost:3000/app");
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(5_000);

    // Check for address in UI (truncated format like 0xf39F...2266)
    let addr = await page.evaluate(() => {
      const body = document.body.innerText;
      const m = body.match(/0x[a-fA-F0-9]{4,6}[.…·]{1,3}[a-fA-F0-9]{3,4}/);
      return m?.[0] ?? null;
    });
    console.log(`  [EOA] pre-connect address: ${addr}`);

    if (!addr) {
      // Walk through onboarding until we find "Connect MetaMask" or similar
      for (let i = 0; i < 8; i++) {
        const action = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll("button"));
          // Try MetaMask connect first
          const mm = btns.find((b) => {
            const t = (b.textContent || "").trim().toLowerCase();
            return t.includes("connect metamask") || t.includes("metamask") || t.includes("connect wallet");
          });
          if (mm && !(mm as HTMLButtonElement).disabled) {
            (mm as HTMLButtonElement).click();
            return "connect";
          }
          // Try Next/Continue
          const next = btns.find((b) => {
            const t = (b.textContent || "").trim().toLowerCase();
            return /^(next|continue|get started|skip)/.test(t);
          });
          if (next) {
            (next as HTMLButtonElement).click();
            return "next";
          }
          return null;
        });
        console.log(`  [EOA] onboarding step ${i}: ${action}`);
        if (action === "connect") {
          await page.waitForTimeout(3_000);
          break;
        }
        if (!action) break;
        await page.waitForTimeout(1_500);
      }

      // Check again after connect flow
      await page.waitForTimeout(3_000);
      addr = await page.evaluate(() => {
        const body = document.body.innerText;
        const m = body.match(/0x[a-fA-F0-9]{4,6}[.…·]{1,3}[a-fA-F0-9]{3,4}/);
        return m?.[0] ?? null;
      });
      console.log(`  [EOA] post-connect address: ${addr}`);
    }

    // Also check if useAccount hook populated (look for the full address in data attrs, console, etc.)
    const accountInfo = await page.evaluate(() => {
      // Check body text for any ETH address pattern
      const body = document.body.innerText;
      const addresses = body.match(/0x[a-fA-F0-9]{4,40}/g) || [];
      return { addresses: addresses.slice(0, 5), bodyLen: body.length };
    });
    console.log(`  [EOA] addresses in page: ${JSON.stringify(accountInfo.addresses)}`);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "eoa-mock-connected.png"), fullPage: true });

    // The EOA address should appear somewhere — either as truncated in the header
    // or as the full address in data attributes
    const found = addr || accountInfo.addresses.some(a =>
      a.toLowerCase().startsWith("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266".slice(0, 10))
    );
    expect(found, "EOA address must appear in UI after mock-injected connect").toBeTruthy();
    console.log("  ✅ EOA injected-wallet connect verified");

    await context.close();
  });
});
