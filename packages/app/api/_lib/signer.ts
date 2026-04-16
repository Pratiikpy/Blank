/**
 * Server-side Signer abstraction.
 *
 * Backends (selected by env):
 *   - "env"  : default — load private key from process.env (current behavior)
 *   - "kms"  : AWS KMS sign — requires KMS_AGENT_KEY_ID / KMS_RELAYER_KEY_ID
 *              env vars + AWS creds via standard AWS SDK chain (IAM role,
 *              AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, etc.). Keys never
 *              leave the HSM — we only ever ask KMS to sign digests.
 *
 * Set BLANK_SIGNER_BACKEND=kms in production. Defaults to "env" for local dev.
 *
 * Both backends implement the small surface ethers needs:
 *   - getAddress(): Promise<string>
 *   - signMessage(msg): Promise<string>  (EIP-191, used by agent attestation)
 *   - ethersSigner: ethers.Signer (passed to `new Contract(addr, abi, signer)`)
 *
 * KMS internals: KMS returns DER-encoded SubjectPublicKeyInfo for the public
 * key (ASN.1 wrapper + 65-byte uncompressed SEC1 point, 0x04 prefix). We strip
 * the wrapper to get the raw 64-byte (X||Y) pubkey, keccak256 it, take the
 * last 20 bytes → Ethereum address. Signatures come back DER-encoded; we parse
 * r/s via @noble/curves and recover v by trying both recovery bits against
 * the cached pubkey.
 */

// KMS SDK intentionally NOT imported at module top level. The AWS SDK is
// several MB and its initialization adds seconds to every cold start — but
// the default env backend (used in prod today) never touches KMS. Lazy-load
// it only inside buildKmsSigner when BLANK_SIGNER_BACKEND=kms. Types are
// referenced via a local declare so env-backend users never require the
// package being resolvable in the bundle.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ethers } from "ethers";

// Minimal structural types — keeps this file typesafe without importing
// the full AWS SDK type surface. Only the shapes we actually touch.
interface KMSClient { send(cmd: unknown): Promise<{ PublicKey?: Uint8Array; Signature?: Uint8Array }>; }
type KMSClientCtor = new (cfg: unknown) => KMSClient;
interface KMSCommand { readonly input: unknown; }
type KMSCommandCtor = new (input: unknown) => KMSCommand;

// Populated on first use in buildKmsSigner. Null until KMS backend is picked.
let kmsModule: {
  KMSClient: KMSClientCtor;
  GetPublicKeyCommand: KMSCommandCtor;
  SignCommand: KMSCommandCtor;
} | null = null;

async function loadKmsModule() {
  if (kmsModule) return kmsModule;
  const mod = await import("@aws-sdk/client-kms");
  kmsModule = {
    KMSClient: mod.KMSClient as unknown as KMSClientCtor,
    GetPublicKeyCommand: mod.GetPublicKeyCommand as unknown as KMSCommandCtor,
    SignCommand: mod.SignCommand as unknown as KMSCommandCtor,
  };
  return kmsModule;
}

export interface BlankSigner {
  getAddress(): Promise<string>;
  signMessage(message: string | Uint8Array): Promise<string>;
  /** ethers v6 Signer compatibility — passed to `new Contract(addr, abi, signer)`. */
  ethersSigner: ethers.Signer;
}

type Backend = "env" | "kms";
type Role = "relayer" | "agent";

function readBackend(): Backend {
  const v = (process.env.BLANK_SIGNER_BACKEND ?? "env").toLowerCase();
  return v === "kms" ? "kms" : "env";
}

/**
 * Build a signer for a named role. The role determines which env vars
 * to look at when backend = "env" and which KMS key alias when backend
 * = "kms".
 */
export function getSigner(role: Role, provider?: ethers.Provider): BlankSigner {
  const backend = readBackend();
  if (backend === "kms") return buildKmsSigner(role, provider);
  return buildEnvSigner(role, provider);
}

// ─── Env backend (current behavior) ─────────────────────────────────────

function buildEnvSigner(role: Role, provider?: ethers.Provider): BlankSigner {
  const envVar = role === "relayer" ? "RELAYER_PRIVATE_KEY" : "AGENT_PRIVATE_KEY";
  const key = process.env[envVar];
  if (!key) throw new Error(`Missing ${envVar} — required when BLANK_SIGNER_BACKEND=env`);

  const wallet = provider ? new ethers.Wallet(key, provider) : new ethers.Wallet(key);
  return {
    async getAddress() { return wallet.address; },
    async signMessage(msg) { return wallet.signMessage(msg); },
    ethersSigner: wallet,
  };
}

// ─── KMS backend ────────────────────────────────────────────────────────

function kmsKeyIdForRole(role: Role): string {
  const envVar = role === "relayer" ? "KMS_RELAYER_KEY_ID" : "KMS_AGENT_KEY_ID";
  const keyId = process.env[envVar];
  if (!keyId) {
    throw new Error(
      `Missing ${envVar} — required when BLANK_SIGNER_BACKEND=kms (role=${role}). ` +
      `Set to a KMS key ID or alias like "alias/blank-${role}".`,
    );
  }
  return keyId;
}

/**
 * Strip the ASN.1 SubjectPublicKeyInfo wrapper KMS returns and extract the
 * raw 64-byte uncompressed pubkey (X || Y), no 0x04 prefix.
 *
 * KMS returns DER like:
 *   30 56                        -- SEQUENCE, 86 bytes
 *     30 10                      -- SEQUENCE, 16 bytes (AlgorithmIdentifier)
 *       06 07 2a8648ce3d0201     --   OID ecPublicKey
 *       06 05 2b8104000a         --   OID secp256k1
 *     03 42 00                   -- BIT STRING, 66 bytes, 0 unused
 *       04 <32-byte X> <32-byte Y>  -- uncompressed SEC1 point
 *
 * Robust approach: find the trailing 0x04 uncompressed prefix within the
 * last 67 bytes — avoids brittle offset math if KMS ever tweaks the DER.
 */
function extractRawPubkey(der: Uint8Array): Uint8Array {
  // The uncompressed point is always the last 65 bytes (04 || X || Y).
  if (der.length < 65) throw new Error(`KMS pubkey DER too short: ${der.length} bytes`);
  const point = der.slice(der.length - 65);
  if (point[0] !== 0x04) {
    throw new Error(
      `Expected uncompressed SEC1 point (0x04 prefix) at end of KMS DER — got 0x${point[0]?.toString(16)}`,
    );
  }
  return point.slice(1); // 64 bytes: X || Y
}

/** Ethereum address = last 20 bytes of keccak256(rawPubkey). */
function addressFromPubkey(rawPubkey: Uint8Array): string {
  const hash = ethers.keccak256(rawPubkey);
  return ethers.getAddress("0x" + hash.slice(-40));
}

/**
 * Given a DER ECDSA signature + the digest that was signed + the known signer
 * pubkey, return a 65-byte Ethereum-style (r, s, v) signature where
 * v ∈ {27, 28}.
 *
 * KMS doesn't tell us which recovery bit is correct, so we try both and pick
 * the one that recovers to our cached pubkey. Also normalize s to low-s
 * (EIP-2) — Ethereum rejects high-s signatures.
 */
function ethSignatureFromKmsDer(
  derSig: Uint8Array,
  digest: Uint8Array,
  expectedPubkey: Uint8Array,
): string {
  const parsed = secp256k1.Signature.fromBytes(derSig, "der");
  let r = parsed.r;
  let s = parsed.s;

  // secp256k1 curve order n
  const n =
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const halfN = n >> 1n;
  if (s > halfN) s = n - s;

  // Try both recovery bits; pick the one that matches the expected pubkey.
  for (const recovery of [0, 1]) {
    try {
      const sig = new secp256k1.Signature(r, s, recovery);
      const point = sig.recoverPublicKey(digest);
      const recovered = point.toBytes(false); // 65 bytes, 04-prefixed uncompressed
      // Strip the 04 prefix for comparison with our stored raw pubkey.
      if (uint8Equal(recovered.slice(1), expectedPubkey)) {
        const v = 27 + recovery;
        const rHex = r.toString(16).padStart(64, "0");
        const sHex = s.toString(16).padStart(64, "0");
        const vHex = v.toString(16).padStart(2, "0");
        return "0x" + rHex + sHex + vHex;
      }
    } catch {
      // recovery failed for this bit — try the other one
    }
  }
  throw new Error("KMS signature did not recover to expected pubkey — key mismatch?");
}

function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** EIP-191 personal_sign prefix wrapping: keccak256("\x19Ethereum Signed Message:\n" + len + msg). */
function eip191Digest(message: string | Uint8Array): Uint8Array {
  const bytes = typeof message === "string" ? ethers.toUtf8Bytes(message) : message;
  const prefix = ethers.toUtf8Bytes(`\x19Ethereum Signed Message:\n${bytes.length}`);
  const concat = new Uint8Array(prefix.length + bytes.length);
  concat.set(prefix, 0);
  concat.set(bytes, prefix.length);
  return ethers.getBytes(ethers.keccak256(concat));
}

/**
 * Core KMS primitive: given a 32-byte digest, ask KMS to sign and return
 * a 65-byte Ethereum signature.
 */
async function kmsSignDigest(
  client: KMSClient,
  keyId: string,
  digest: Uint8Array,
  expectedPubkey: Uint8Array,
): Promise<string> {
  if (digest.length !== 32) {
    throw new Error(`kmsSignDigest expects a 32-byte digest, got ${digest.length}`);
  }
  const { SignCommand } = await loadKmsModule();
  const cmd = new SignCommand({
    KeyId: keyId,
    Message: digest,
    MessageType: "DIGEST",
    SigningAlgorithm: "ECDSA_SHA_256",
  });
  const res = await client.send(cmd);
  const der = res.Signature;
  if (!der) throw new Error("KMS SignCommand returned no Signature");
  return ethSignatureFromKmsDer(der as Uint8Array, digest, expectedPubkey);
}

/**
 * An ethers.AbstractSigner implementation backed by KMS. Only hot path:
 * signTransaction hashes the unsigned tx, asks KMS to sign, attaches the
 * signature. AbstractSigner's default sendTransaction handles broadcast.
 *
 * signTypedData is implemented for completeness (EIP-712 hash → KMS sign).
 */
class KmsEthersSigner extends ethers.AbstractSigner<null | ethers.Provider> {
  readonly #client: KMSClient;
  readonly #keyId: string;
  readonly #address: string;
  readonly #rawPubkey: Uint8Array;

  constructor(
    client: KMSClient,
    keyId: string,
    address: string,
    rawPubkey: Uint8Array,
    provider: null | ethers.Provider,
  ) {
    super(provider);
    this.#client = client;
    this.#keyId = keyId;
    this.#address = address;
    this.#rawPubkey = rawPubkey;
  }

  async getAddress(): Promise<string> {
    return this.#address;
  }

  connect(provider: null | ethers.Provider): ethers.Signer {
    return new KmsEthersSigner(this.#client, this.#keyId, this.#address, this.#rawPubkey, provider);
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    const digest = eip191Digest(message);
    return kmsSignDigest(this.#client, this.#keyId, digest, this.#rawPubkey);
  }

  async signTransaction(tx: ethers.TransactionRequest): Promise<string> {
    // Resolve any lazy fields (provider lookups for chainId/nonce etc.)
    const populated = await this.populateTransaction(tx);
    // `from` must match; ethers fills it during populate, strip for unsigned serialize.
    delete populated.from;
    const ethersTx = ethers.Transaction.from(populated);
    const unsignedHash = ethers.getBytes(ethersTx.unsignedHash);

    const sigHex = await kmsSignDigest(this.#client, this.#keyId, unsignedHash, this.#rawPubkey);
    // sigHex is 0x{r}{s}{v} with v ∈ {27, 28}. ethers.Signature accepts this.
    ethersTx.signature = ethers.Signature.from(sigHex);
    return ethersTx.serialized;
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<ethers.TypedDataField>>,
    value: Record<string, any>,
  ): Promise<string> {
    const digest = ethers.getBytes(ethers.TypedDataEncoder.hash(domain, types, value));
    return kmsSignDigest(this.#client, this.#keyId, digest, this.#rawPubkey);
  }
}

// In-process cache: KMS GetPublicKey is a network call we only need once per
// role per boot. Keyed by role so relayer + agent don't share state.
const pubkeyCache = new Map<Role, { address: string; rawPubkey: Uint8Array }>();

async function resolveKmsPubkey(
  client: KMSClient,
  role: Role,
  keyId: string,
): Promise<{ address: string; rawPubkey: Uint8Array }> {
  const cached = pubkeyCache.get(role);
  if (cached) return cached;

  const { GetPublicKeyCommand } = await loadKmsModule();
  const cmd = new GetPublicKeyCommand({ KeyId: keyId });
  const res = await client.send(cmd);
  const der = res.PublicKey;
  if (!der) throw new Error(`KMS GetPublicKey returned no PublicKey for role=${role}`);
  const rawPubkey = extractRawPubkey(der as Uint8Array);
  const address = addressFromPubkey(rawPubkey);
  const entry = { address, rawPubkey };
  pubkeyCache.set(role, entry);
  return entry;
}

// Lazy KMS client — created on first use, shared across roles. Async because
// we now dynamic-import the SDK only when KMS backend is requested.
let sharedKmsClient: KMSClient | undefined;
async function getKmsClient(): Promise<KMSClient> {
  if (!sharedKmsClient) {
    const { KMSClient } = await loadKmsModule();
    // Region + credentials resolved from the standard AWS env chain:
    // AWS_REGION (or AWS_DEFAULT_REGION), AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY,
    // IAM role on EC2/ECS/Lambda, etc.
    sharedKmsClient = new KMSClient({});
  }
  return sharedKmsClient;
}

function buildKmsSigner(role: Role, provider?: ethers.Provider): BlankSigner {
  const keyId = kmsKeyIdForRole(role);
  // Don't instantiate the client synchronously — loading @aws-sdk/client-kms
  // is async now. Each async method below fetches the client on first use.
  const withClient = <T>(fn: (c: KMSClient) => Promise<T>): Promise<T> =>
    getKmsClient().then(fn);

  // Resolve pubkey+address lazily on first call — async work can't happen in
  // this synchronous factory. Cache the promise so concurrent callers share.
  let resolved: Promise<{ address: string; rawPubkey: Uint8Array }> | undefined;
  const getResolved = () => {
    if (!resolved) resolved = withClient((c) => resolveKmsPubkey(c, role, keyId));
    return resolved;
  };

  let cachedSigner: KmsEthersSigner | undefined;
  const buildEthersSigner = async (): Promise<KmsEthersSigner> => {
    if (cachedSigner) return cachedSigner;
    const { address, rawPubkey } = await getResolved();
    const client = await getKmsClient();
    cachedSigner = new KmsEthersSigner(client, keyId, address, rawPubkey, provider ?? null);
    return cachedSigner;
  };

  // `ethersSigner` must be returned synchronously (it gets passed to
  // `new ethers.Contract(addr, abi, signer)`). We expose a Proxy that
  // lazily resolves the real signer on first async method call. Contract
  // calls always hit the async methods (getAddress, signTransaction,
  // sendTransaction etc.), so by the time ethers actually needs the KMS
  // pubkey we've had time to fetch it.
  const lazySigner = new Proxy({} as ethers.Signer, {
    get(_target, prop, _receiver) {
      // `provider` is accessed synchronously by ethers in some paths.
      if (prop === "provider") return provider ?? null;
      // Symbol-based introspection and `then` (to avoid being mistakenly
      // treated as a thenable) — bail out cleanly.
      if (typeof prop === "symbol" || prop === "then") return undefined;

      // For `connect`, we can build a fresh signer synchronously if we
      // already have the cached one; otherwise return a wrapped fn that
      // resolves it first.
      if (prop === "connect") {
        return (newProvider: null | ethers.Provider) => {
          if (cachedSigner) return cachedSigner.connect(newProvider);
          // Build a new lazy signer with the new provider.
          return buildKmsSigner(role, newProvider ?? undefined).ethersSigner;
        };
      }

      // Everything else: assume async. Return a function that awaits the
      // real signer then delegates. This covers getAddress, signMessage,
      // signTransaction, signTypedData, sendTransaction, getNonce,
      // populateCall, populateTransaction, estimateGas, call, resolveName.
      return async (...args: unknown[]) => {
        const signer = await buildEthersSigner();
        const fn = (signer as any)[prop];
        if (typeof fn !== "function") {
          throw new Error(`KmsEthersSigner has no method "${String(prop)}"`);
        }
        return fn.apply(signer, args);
      };
    },
  });

  return {
    async getAddress() {
      const { address } = await getResolved();
      return address;
    },
    async signMessage(msg) {
      const { rawPubkey } = await getResolved();
      const digest = eip191Digest(msg);
      return withClient((c) => kmsSignDigest(c, keyId, digest, rawPubkey));
    },
    ethersSigner: lazySigner,
  };
}
