// Wave 5 Block 8 — in-app help articles.
//
// 10 starter articles per WAVE5_PLAN.md §8.1. Each is short, terse,
// technical. No marketing fluff. Sources reference live screens by
// route so the support drawer can deep-link. Article body is plain
// markdown with code spans for paths + commands.
//
// External docs site (docs.blank.app) renders the same array.

export interface HelpArticle {
  slug: string;
  title: string;
  category: "Basics" | "Wallet" | "Payments" | "Recovery" | "Privacy" | "Wave 5";
  body: string;
  /** Optional deep-link to the relevant in-app surface. */
  cta?: { label: string; href: string };
  /** For Lunr search indexing — keywords / synonyms. */
  keywords: string[];
}

export const HELP_ARTICLES: HelpArticle[] = [
  {
    slug: "first-send",
    title: "Send your first encrypted payment",
    category: "Payments",
    keywords: ["send", "payment", "first", "transfer", "p2p"],
    body:
`After you create a passkey wallet and shield USDC, head to /app/send.

1. Paste a recipient address or pick a contact.
2. Enter the USDC amount.
3. Press Send. Your passphrase prompt appears; enter it once.
4. The transaction signs via the FHE encrypt + AA UserOp path. Real
   tx hash returned in 10-30 seconds.

The amount stays encrypted on chain. Only you and the recipient can
decrypt the value via your respective passkey-bound permits.`,
    cta: { label: "Open send", href: "/app/send" },
  },

  {
    slug: "receive-payments",
    title: "Receive payments",
    category: "Payments",
    keywords: ["receive", "address", "qr", "incoming"],
    body:
`Anyone can pay your smart-account address. Find it on /app/wallet.

If your sender has the Blank app, they can also send by @handle
(see "What is a handle"). If they're stealth-aware, they can send
to your stealth meta-address via /app/privacy without ever seeing
your main wallet address.`,
    cta: { label: "Open wallet", href: "/app/wallet" },
  },

  {
    slug: "shield-usdc",
    title: "Shield USDC into the encrypted vault",
    category: "Wallet",
    keywords: ["shield", "deposit", "encrypt", "vault", "FHE"],
    body:
`To use the encrypted-amount features you first move USDC into
the FHERC20Vault on the active chain.

1. Open /app/wallet.
2. Press Shield.
3. Enter the amount. Approve the USDC allowance (one-time per chain).
4. Press Shield again. The amount lands in the vault encrypted.

Once shielded the on-chain balance is an FHE handle. The plaintext
amount lives only inside your client-side permits.`,
    cta: { label: "Open wallet", href: "/app/wallet" },
  },

  {
    slug: "unshield-usdc",
    title: "Unshield USDC back to your EOA",
    category: "Wallet",
    keywords: ["unshield", "withdraw", "exit", "decrypt", "plaintext"],
    body:
`Reverse of shield. The amount becomes visible at the moment of
unshield because USDC on the underlying ERC-20 is plaintext.

1. /app/wallet -> Unshield tab.
2. Enter amount + optional destination (defaults to your EOA).
3. Sign. The vault transfers underlying USDC to the destination.

If you want privacy-preserving exit, route through the P2P offramp
(/app/offramp) instead.`,
    cta: { label: "Open wallet", href: "/app/wallet" },
  },

  {
    slug: "passkey-basics",
    title: "Passkey wallet basics",
    category: "Wallet",
    keywords: ["passkey", "passphrase", "p-256", "indexeddb", "key", "backup"],
    body:
`Your passkey is a P-256 keypair encrypted with your passphrase, stored
in IndexedDB on this device. Every transaction needs the passphrase.

Two things to know:

1. Your passphrase never leaves this browser. Lose it and you lose
   access. Save a backup somewhere safe (password manager, written
   copy in a safe).

2. If you lose the device entirely, see "Recover a lost passkey"
   for the guardian recovery flow.`,
    cta: { label: "Open settings", href: "/app/settings" },
  },

  {
    slug: "recover-passkey",
    title: "Recover a lost passkey",
    category: "Recovery",
    keywords: ["recover", "lost", "guardian", "social", "new device", "veto"],
    body:
`Set up guardians BEFORE you need them. Settings -> Recovery, add at
least 3 trusted addresses and pick a threshold (default 2 of 3).

Lost passkey flow:

1. On a fresh device, generate a NEW smart-account address (passkey
   create flow).
2. Open /recover/<your-handle>. Paste the new smart-account address.
3. A guardian submits the request. Other guardians approve.
4. After the challenge window and threshold are met, anyone can
   finalize. BlankAccount's owner-rotation hook lands in Wave 5.5;
   the state machine is live in v1.`,
    cta: { label: "Open recovery", href: "/app/settings" },
  },

  {
    slug: "what-is-a-handle",
    title: "What is an @handle",
    category: "Basics",
    keywords: ["handle", "username", "identity", "alias", "blankhandles"],
    body:
`Per-chain identity. "@alice.eth" is independent from "@alice.base"
even if the same person owns both.

Rules:
  - 3-24 chars, alphanumeric + . - _
  - Case-insensitive uniqueness
  - One handle per address
  - Short (3-4 char) names are admin-only at v1; community auction
    is Wave 6 work

Anti-phishing: if you set an email digest on your handle, senders
verify it matches before sending. Defends against typo-squat
look-alike handles.`,
    cta: { label: "Reserve a handle", href: "/app/settings" },
  },

  {
    slug: "use-offramp",
    title: "Use the P2P offramp",
    category: "Wave 5",
    keywords: ["offramp", "fiat", "p2p", "upi", "venmo", "wise", "paypal", "sell"],
    body:
`Convert encrypted USDC to fiat via a real human peer.

1. /app/offramp -> New offer (as maker) or browse (as taker).
2. Maker posts an encrypted USDC amount + plaintext fiat price
   + rail (UPI, Wise, Venmo, PayPal).
3. Taker takes the offer. Maker's USDC moves into escrow.
4. Taker pays the maker off-chain via the rail.
5. Taker submits a Reclaim Protocol attestation (zkTLS proof of
   the fiat payment).
6. After a challenge window, anyone can release the USDC to taker.

If the proof is bad, maker disputes. Arbiter (3-of-5 multisig)
resolves.`,
    cta: { label: "Open offramp", href: "/app/offramp" },
  },

  {
    slug: "invoice-flow",
    title: "Create and pay an invoice",
    category: "Payments",
    keywords: ["invoice", "vendor", "client", "billing", "business"],
    body:
`Vendor side:

1. /app/business -> Invoices -> New invoice.
2. Enter client address, amount, due date, description.
3. Send the invoice link. The amount is encrypted on chain.

Client side:

1. Open the invoice link.
2. Press Pay. Two paths:
   - Direct pay (cheaper, less safe; vendor controls refund)
   - Escrow pay (safer; funds released by vendor or refunded if
     amount mismatch)

Wave 4 anti-cheat fix: vendor refund can no longer pass a partial
amount; the contract enforces the full original invoice amount.`,
    cta: { label: "Open business tools", href: "/app/business" },
  },

  {
    slug: "encrypted-escrow",
    title: "Encrypted escrow walkthrough",
    category: "Wave 5",
    keywords: ["escrow", "milestone", "freelance", "arbiter", "release"],
    body:
`Two-party encrypted escrow with optional arbiter. /app/escrow.

Flow:

1. Depositor creates an escrow with vault, beneficiary, encrypted
   amount, deadline, optional arbiter.
2. Beneficiary delivers off-chain and calls markDelivered.
3. Depositor calls approveRelease -> funds release to beneficiary.
4. Disputes route to arbiter (if set) or claimable by depositor
   after deadline.

The legacy BusinessHub escrow stored amounts in plaintext. The new
EncryptedEscrow stores everything as FHE handles. BusinessTools
banner points to the new path.`,
    cta: { label: "Open escrow", href: "/app/escrow" },
  },
];

export function searchHelp(query: string): HelpArticle[] {
  const q = query.toLowerCase().trim();
  if (!q) return HELP_ARTICLES;
  return HELP_ARTICLES.filter((a) => {
    if (a.title.toLowerCase().includes(q)) return true;
    if (a.body.toLowerCase().includes(q)) return true;
    if (a.keywords.some((k) => k.toLowerCase().includes(q))) return true;
    if (a.category.toLowerCase().includes(q)) return true;
    return false;
  });
}
