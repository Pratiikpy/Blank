import type { BlogPost } from "./posts";

const post: BlogPost = {
  slug: "wave-3-shipped",
  title: "Wave 3: workspace modes, private invoice escrow, proof-of-payment",
  date: "2026-04-29",
  summary:
    "What landed in Wave 3, why each piece was the right call, and what we deliberately didn't ship.",
  author: "The Blank team",
  category: "changelog",
  readingTimeMin: 6,
  content: () => (
    <>
      <p>
        Wave 3 closed on April 29 with three big shipments and a
        stack of smaller hardening that mostly nobody will notice
        unless they're auditing us. Here's what landed and the
        reasoning behind each call.
      </p>

      <h2>Private invoice escrow: the wedge</h2>
      <p>
        Until Wave 3, Blank had a powerful primitive (encrypted
        amounts) but no clear answer to "what's the first thing a
        new user should do." We picked one: <strong>send a private
        invoice and get paid privately</strong>. Everything else is
        secondary.
      </p>
      <p>
        Mechanically, the new escrow flow goes:
      </p>
      <ol>
        <li>
          Vendor creates an invoice with an encrypted amount on
          BusinessHub. Public link generated:{" "}
          <code>/app/invoice/&lt;chain&gt;/&lt;id&gt;</code>.
        </li>
        <li>
          Client opens the link without an account. Connects a wallet
          (or creates a passkey on the spot). Pays into a vault-held
          escrow.
        </li>
        <li>
          Contract runs <code>FHE.eq(escrowed, expected)</code> +{" "}
          <code>FHE.select</code>. On match: funds release to vendor.
          On mismatch: funds refund to client. No arbiter, no manual
          dispute, no trust.
        </li>
        <li>
          Vendor sees a proof-of-payment card with a real explorer
          link to the settlement tx.
        </li>
      </ol>
      <p>
        The thing that actually took the longest wasn't the contract
        — it was the cross-contract input verification primitive,{" "}
        <code>transferVerified(to, euint64)</code>. BusinessHub
        verifies the client's encrypted input in its own{" "}
        <code>msg.sender</code> context, then hands the verified
        handle to the vault. Without this primitive, the cross-contract
        FHE signature check fails silently and nothing tells you why.
        It's a CoFHE-specific landmine that's worth knowing about if
        you're building on the same stack.
      </p>

      <h2>Workspace modes: the hide-the-menu fix</h2>
      <p>
        Twelve product surfaces in one app is a feature pile that
        scares new users. The fix: pick a focus mode (Freelancer,
        Business, Privacy, Full), and the nav, search, and feature
        surface adapt to your role. Single source of truth in{" "}
        <code>nav-registry.ts</code> drives the desktop sidebar,
        mobile bottom-bar, and search index — adding a screen lights
        up everywhere at once.
      </p>
      <p>
        The mode picker is a localStorage preference, not an
        on-chain identity. Switching modes never hides your data —
        every screen still works via direct URL. This is a
        presentation-layer optimization, not a permission system.
      </p>

      <h2>Proof-of-payment cards</h2>
      <p>
        After settlement the vendor sees a card with the real
        Basescan/Etherscan link to the settlement transaction.
        Sounds small. It changes the trust dynamic completely:
        the proof of payment is the chain, not our database. The
        vendor can hand the link to anyone — accountant, auditor,
        a skeptical buyer wondering if the invoice cleared — and
        it's verifiable without trusting Blank.
      </p>

      <h2>Smaller things worth mentioning</h2>
      <ul>
        <li>
          <strong>UUPS gap slots on every contract.</strong> Storage
          fragility was the biggest sleeper risk in our codebase.
          Now every hub reserves <code>uint256[50] private __gap</code>{" "}
          and CI fails any upgrade that doesn't preserve append-only
          ordering.
        </li>
        <li>
          <strong>SafeERC20 in BusinessHub escrow paths.</strong>{" "}
          A non-standard token returning <code>false</code> from{" "}
          <code>transferFrom</code> would have left the escrow in
          a "released" state with no funds moved. Fixed.
        </li>
        <li>
          <strong>Stealth keystore is now AES-GCM-at-rest.</strong>{" "}
          Plaintext private keys were sitting in localStorage with a
          comment that said "Phase 9.6 will fix this." Phase 9.6
          shipped.
        </li>
        <li>
          <strong>Email-trigger endpoints fail-closed by default.</strong>{" "}
          The earlier shape would let anyone who knew an invoice ID
          spam the client's inbox. Now every email send requires a
          wallet signature.
        </li>
        <li>
          <strong>Security headers landed in vercel.json.</strong> CSP,
          X-Frame-Options DENY, Permissions-Policy, Referrer-Policy.
          (And then we found out our CSP was too strict for Web3
          libraries — wrote that up separately.)
        </li>
      </ul>

      <h2>What we deliberately didn't ship</h2>
      <p>
        This is more interesting than the ship list:
      </p>
      <ul>
        <li>
          <strong>No token.</strong> Discussed{" "}
          <a href="/blog/why-no-token-ever">at length</a>.
        </li>
        <li>
          <strong>No mainnet.</strong> Gated on Fhenix CoFHE
          mainnet + a third-party audit + threshold operator
          decentralization. All three are external dependencies
          we don't speculate dates on. Public roadmap for the
          long version.
        </li>
        <li>
          <strong>No expansion to a third chain.</strong> Base
          Sepolia + Ethereum Sepolia is the surface. We pick two
          chains and ship them well rather than seven and ship them
          badly.
        </li>
        <li>
          <strong>No creator-economy super-app pivot.</strong>{" "}
          Tempting (the adjacent space is hot) but it would dilute
          the wedge. We stayed on the freelancer/agency line.
        </li>
      </ul>

      <h2>What's next</h2>
      <p>
        Wave 4 is being scoped, but the priorities won't be
        secret: an SDK so the privacy layer becomes embeddable
        anywhere, a proper design system extracted from the
        screens we've shipped, a trust layer (audit + status
        page + bug bounty), and the boring-but-important work of
        cleaning up the technical debt that accumulates when
        you ship 12 features in one wave.
      </p>
      <p>
        The roadmap will live at <a href="/roadmap">/roadmap</a> with
        explicit dependencies. We don't promise dates, but we
        publish what blocks each step.
      </p>
    </>
  ),
};

export default post;
