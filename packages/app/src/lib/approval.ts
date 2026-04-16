const APPROVED_KEY = "blank_vault_approved_v2";

// #102: approvals used to be keyed only by spender → leaked across wallet
// switches AND chain switches, producing "insufficient allowance" reverts
// on first shield/send after a wallet change.
//
// Fix: key by (sender, spender, chainId). Call sites don't pass sender +
// chainId (there are ~30 of them) — instead AppProviders calls
// setApprovalContext(address, chainId) whenever those change, and the
// helpers read from module-level state.

const TTL_MS = 24 * 60 * 60 * 1000;

let _activeSender: string | undefined;
let _activeChainId: number | undefined;

export function setApprovalContext(
  sender: string | undefined,
  chainId: number | undefined
) {
  _activeSender = sender?.toLowerCase();
  _activeChainId = chainId;
}

function buildKey(spender: string): string | null {
  if (!_activeSender || !_activeChainId) return null;
  return `${_activeSender}:${spender.toLowerCase()}:${_activeChainId}`;
}

export function isVaultApproved(spender: string): boolean {
  const key = buildKey(spender);
  if (!key) return false;
  try {
    const approved = JSON.parse(localStorage.getItem(APPROVED_KEY) || "{}") as Record<string, number>;
    const ts = approved[key];
    if (!ts) return false;
    if (Date.now() - ts > TTL_MS) return false;
    return true;
  } catch {
    return false;
  }
}

// #252: cross-device approval recovery. Sync cache is keyed by
// (sender, spender, chainId); on a fresh localStorage the cache is empty
// even if the on-chain allowance is already set. Re-approving costs an
// extra prompt/UserOp and — under public-RPC load — sometimes stalls on
// `waitForTransactionReceipt`. verifyVaultApproved falls back to an
// on-chain event log scan: FHERC20Vault emits `EncryptedApproval(owner,
// spender, timestamp)` on every approvePlaintext, and those logs ARE
// plaintext even though the allowance value itself is encrypted.
//
// Kept alongside the sync `isVaultApproved` because some render-path code
// needs a synchronous answer. Hooks that gate writes should prefer this
// async variant.
//
// Note: an EncryptedApproval event means the user once approved the
// spender. The allowance value itself is encrypted and may have been
// spent down or reset to zero in a later approve. For our lazy
// MAX_UINT64 approval pattern this is fine — users who approved once
// are still approved.
export async function verifyVaultApproved(
  spender: `0x${string}`,
  sender: `0x${string}`,
  vault: `0x${string}`,
  publicClient: {
    getLogs: (args: {
      address: `0x${string}`;
      event: {
        type: "event";
        name: string;
        inputs: readonly { type: string; name: string; indexed?: boolean }[];
      };
      args: Record<string, unknown>;
      fromBlock?: bigint | "earliest" | "latest";
      toBlock?: bigint | "earliest" | "latest";
    }) => Promise<unknown[]>;
  },
): Promise<boolean> {
  if (isVaultApproved(spender)) return true;
  try {
    const logs = await publicClient.getLogs({
      address: vault,
      event: {
        type: "event",
        name: "EncryptedApproval",
        inputs: [
          { type: "address", name: "owner", indexed: true },
          { type: "address", name: "spender", indexed: true },
          { type: "uint256", name: "timestamp", indexed: false },
        ],
      },
      args: { owner: sender, spender },
      fromBlock: "earliest",
      toBlock: "latest",
    });
    if (logs.length > 0) {
      markVaultApproved(spender);
      return true;
    }
  } catch (e) {
    console.warn("[approval] on-chain event scan failed", e);
  }
  return false;
}

export function markVaultApproved(spender: string) {
  const key = buildKey(spender);
  if (!key) return;
  try {
    const approved = JSON.parse(localStorage.getItem(APPROVED_KEY) || "{}") as Record<string, number>;
    approved[key] = Date.now();
    localStorage.setItem(APPROVED_KEY, JSON.stringify(approved));
  } catch {
    /* storage quota / disabled — non-fatal, will re-approve next time */
  }
}

export function clearVaultApproval(spender: string) {
  const key = buildKey(spender);
  if (!key) return;
  try {
    const approved = JSON.parse(localStorage.getItem(APPROVED_KEY) || "{}") as Record<string, number>;
    delete approved[key];
    localStorage.setItem(APPROVED_KEY, JSON.stringify(approved));
  } catch {
    /* storage quota / disabled */
  }
}

// One-time migration — clear the legacy global key used before #102 was fixed.
// Prevents stale "already approved" states when the app upgrades for existing users.
try {
  localStorage.removeItem("blank_vault_approved");
} catch {
  /* noop */
}
