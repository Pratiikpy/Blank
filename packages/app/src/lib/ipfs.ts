// Thin wrapper around Pinata's REST API for pinning files and JSON to IPFS.
//
// Used by Phase 1 (invoice PDFs) and Phase 3 (escrow file attachments). The
// content hash (CID) returned here is what we store on-chain; IPFS itself
// hosts the bytes.
//
// SECURITY NOTE: Client-side uploads using `VITE_PINATA_JWT` ship the token
// to every browser. That's acceptable on testnet with a *scoped* upload-only
// key (Pinata supports per-key permissions), and we fall back to a server
// endpoint in production. The functions below let the caller choose by
// passing a `jwt` arg, or default to the env var.
//
// Pinata REST API:
//   POST /pinning/pinFileToIPFS   multipart form  → { IpfsHash, PinSize, Timestamp }
//   POST /pinning/pinJSONToIPFS   JSON body       → same response
//
// Docs: https://docs.pinata.cloud/api-reference/endpoint/pin-file-to-ipfs

const PINATA_BASE_URL = "https://api.pinata.cloud";
const DEFAULT_GATEWAY = "https://gateway.pinata.cloud/ipfs";
const FALLBACK_GATEWAY = "https://ipfs.io/ipfs";

export interface PinResult {
  /** IPFS content identifier (CIDv0 / v1). Store this on-chain. */
  cid: string;
  /** Pinned bytes count. */
  size: number;
  /** ISO-8601 timestamp from Pinata. */
  pinnedAt: string;
}

interface PinataResponse {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
}

function envJwt(): string | undefined {
  if (typeof import.meta === "undefined") return undefined;
  const env = import.meta.env as Record<string, string | undefined>;
  const trimmed = env.VITE_PINATA_JWT?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function requireJwt(jwt: string | undefined): string {
  const token = jwt ?? envJwt();
  if (!token) {
    throw new Error(
      "Pinata JWT missing. Set VITE_PINATA_JWT or pass `jwt` arg.",
    );
  }
  return token;
}

function toResult(data: PinataResponse): PinResult {
  return { cid: data.IpfsHash, size: data.PinSize, pinnedAt: data.Timestamp };
}

/** Upload a `Blob` / `File` to IPFS via Pinata. Returns the resulting CID. */
export async function pinFile(
  file: Blob,
  options: { name?: string; jwt?: string } = {},
): Promise<PinResult> {
  const token = requireJwt(options.jwt);
  const form = new FormData();
  form.append("file", file, options.name ?? "upload");
  if (options.name) {
    form.append("pinataMetadata", JSON.stringify({ name: options.name }));
  }
  const res = await fetch(`${PINATA_BASE_URL}/pinning/pinFileToIPFS`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pinata pinFile failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as PinataResponse;
  return toResult(data);
}

/** Pin a JSON-serialisable value to IPFS. Returns the CID. */
export async function pinJson(
  value: unknown,
  options: { name?: string; jwt?: string } = {},
): Promise<PinResult> {
  const token = requireJwt(options.jwt);
  const body: Record<string, unknown> = { pinataContent: value };
  if (options.name) {
    body.pinataMetadata = { name: options.name };
  }
  const res = await fetch(`${PINATA_BASE_URL}/pinning/pinJSONToIPFS`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Pinata pinJson failed (${res.status}): ${detail}`);
  }
  const data = (await res.json()) as PinataResponse;
  return toResult(data);
}

/** Build a public HTTP URL to fetch CID via Pinata's gateway. */
export function ipfsUrl(cid: string, gateway: string = DEFAULT_GATEWAY): string {
  return `${gateway}/${cid}`;
}

/** Public IPFS.io gateway — useful as a fallback if Pinata's gateway is slow. */
export function ipfsFallbackUrl(cid: string): string {
  return `${FALLBACK_GATEWAY}/${cid}`;
}

/**
 * Fetch a CID's bytes through Pinata's gateway, falling back to ipfs.io if
 * Pinata returns a non-2xx (e.g. unpinned). Returns the response — caller
 * decides how to consume (`.blob()`, `.json()`, etc.).
 */
export async function fetchFromIpfs(cid: string): Promise<Response> {
  const primary = await fetch(ipfsUrl(cid)).catch(() => null);
  if (primary && primary.ok) return primary;
  return fetch(ipfsFallbackUrl(cid));
}
