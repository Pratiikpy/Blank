import type { BlogPost } from "./posts";

const post: BlogPost = {
  slug: "why-fhenix-cofhe",
  title: "Why we built Blank on Fhenix CoFHE, not on an FHE L1",
  date: "2026-05-01",
  summary:
    "There are multiple FHE projects you could build on today. We picked Fhenix. The reason isn't 'FHE is better'. It's that Fhenix's specific architectural shape, the co-processor, is the right shape for application builders shipping on Ethereum.",
  author: "The Blank team",
  category: "deep-dive",
  readingTimeMin: 8,
  content: () => (
    <>
      <p>
        Before we wrote a line of code we had to make the most
        consequential technical decision of the project: which FHE
        stack to build on. It wasn't between FHE and ZK (that's a
        different post). It was between several FHE projects, all
        serious, all well-funded, all with real engineers shipping
        real code.
      </p>
      <p>
        We picked <strong>Fhenix CoFHE</strong>. This post is about why,
        with as much specificity as we can give. The honest version
        isn't "Fhenix is the best FHE". It's "Fhenix's specific
        architectural shape, the co-processor model, is the right shape
        for application builders who want to ship on Ethereum without
        fragmenting their liquidity, their tooling, or their users into
        a separate world."
      </p>

      <h2>The architectural fork: L1 vs co-processor</h2>
      <p>
        Most FHE-on-blockchain projects choose one of two paths.
      </p>
      <p>
        <strong>Path 1: FHE Layer 1.</strong> Every node in the network
        runs FHE operations. The chain itself is FHE-native. Inco and
        parts of Zama's roadmap point this direction. The benefit is
        purity. The security model collapses to "if the chain is
        secure, FHE is secure." The cost is that you've built a new
        chain, with all the bootstrapping problems that implies:
        wallets don't natively support it, bridges have to exist,
        liquidity has to be onboarded, every existing dapp has to
        be ported or replaced.
      </p>
      <p>
        <strong>Path 2: FHE co-processor.</strong> The base chain is
        plain Ethereum (or any EVM L2). FHE operations are delegated
        to a specialised network of operators that compute on
        ciphertext, return results, and produce permits the EVM can
        verify. That's what Fhenix CoFHE is: explicitly a <em>co-
        processor</em>, not a chain. Their FHE compute happens off the
        main chain; the EVM contract code references handles
        (<code>euint64</code>, <code>ebool</code>) and dispatches work
        to an on-chain TaskManager that the co-processor reads from.
      </p>
      <p>
        The trade-off is real. The co-processor model adds a trust
        assumption — the threshold network of operators must not collude
        to decrypt or forge results. The L1 model has no such
        assumption (only the chain's consensus). But the co-processor
        gets you something the L1 can't: <strong>your contracts deploy
        on Ethereum.</strong> An FHE-native function lives next to a
        regular ERC-20 transfer, in the same transaction, in the same
        block. Wallets work. Etherscan works. Existing infrastructure
        works.
      </p>
      <p>
        For a payments app this matters more than for almost any other
        category. We need users with regular wallets, paying regular
        addresses, in a regular way — except for one specific field
        (the amount) which is encrypted. That's exactly the shape
        co-processor architecture gives you, and it's exactly the
        shape an FHE L1 makes harder.
      </p>

      <h2>What "co-processor" actually means in CoFHE</h2>
      <p>
        Concretely, when our contract runs:
      </p>
      <pre>
{`euint64 amount = FHE.asEuint64(encInput);
balance = FHE.add(balance, amount);
FHE.allowSender(balance);`}
      </pre>
      <p>
        The on-chain code stores a 32-byte handle — a reference to
        ciphertext that lives in the co-processor network's storage,
        not in the EVM. <code>FHE.add</code> doesn't actually compute
        anything on-chain. It dispatches a task to the on-chain
        TaskManager; the co-processor picks it up, performs the
        homomorphic addition off-chain, and writes a result handle
        back. <code>FHE.allowSender</code> records permits — a list
        of addresses authorised to ask the threshold network for
        decryption permits later.
      </p>
      <p>
        This split — handles on-chain, ciphertext off-chain, threshold
        network in the middle — is the right division of labour. It
        means our gas costs are sane (the EVM doesn't run TFHE; it
        runs handle bookkeeping). It means decryption happens
        asynchronously by addresses you've explicitly granted access
        to. It means the chain stays cheap enough to be Ethereum.
      </p>

      <h2>The API design choices that closed the deal</h2>
      <p>
        Architecture chose the category. The thing that made us pick
        Fhenix specifically over alternatives in the same category was
        the API. A few choices that look small on paper but compound
        across a real production codebase:
      </p>
      <p>
        <strong>FHE.select() instead of branching.</strong> A normal
        Solidity contract checks balances with <code>require(balance
        &gt;= amount)</code>. That revert leaks one bit of information
        per attempt — enough reverts and an attacker reconstructs your
        balance. Fhenix bakes <code>FHE.select(condition, ifTrue,
        ifFalse)</code> directly into the API as a first-class
        primitive — branching on encrypted data without leaking which
        branch was taken. It's a small thing. Across our codebase it
        eliminated a class of bugs we would have written on autopilot
        if the primitive hadn't been right there.
      </p>
      <p>
        <strong>The four-tier ACL.</strong> Fhenix splits decrypt
        permissions into four primitives:{" "}
        <code>allowThis</code> (this contract can read its own
        ciphertext), <code>allowSender</code> (the EOA who called the
        function can read), <code>allow(addr)</code> (a specific
        address can read), <code>allowTransient(addr)</code> (the
        address can read inside the current transaction only).
        Categorical, four-way, exhaustive. Once you internalise the
        difference between transient and permanent permits, you stop
        accidentally granting too much access. Compare to a lot of
        permission systems that ship with a single boolean flag.
      </p>
      <p>
        <strong>Input verification context-bound to msg.sender.</strong>{" "}
        This one bit us during Wave 3 and we've since come to
        appreciate why it had to be that way. When a user submits an
        encrypted input, <code>FHE.asEuint64(encInput)</code> verifies
        the ZK proof attached to it — but the verification is bound to{" "}
        <code>msg.sender</code> at the moment <code>asEuint64</code>{" "}
        runs. If our hub contract calls our vault contract and lets
        the vault verify the input, <code>msg.sender</code> is the hub,
        not the original user — and the proof fails. Took us a day to
        diagnose. The fix was a <code>transferVerified</code> primitive
        on the vault that accepts an already-verified handle. Once we
        understood the design, we agreed with it: the alternative
        (allowing any contract to forge "user authorised this" claims)
        would be much worse.
      </p>
      <p>
        <strong>The TFHE WASM client.</strong> Encryption happens in
        the user's browser, not on a server we operate. Plaintext
        never leaves the device. Fhenix's <code>@cofhe/sdk</code> ships
        a TFHE WASM module that runs in a Web Worker — fast enough that
        encrypting a 64-bit amount feels like any other JS operation.
        For a privacy app, "client-side encryption with no server
        round-trip" is non-negotiable, and getting it to work browser-
        side without weeks of WASM tuning is a real gift.
      </p>
      <p>
        <strong>Hardhat plugin + mock contracts for local dev.</strong>{" "}
        Fhenix's <code>@cofhe/hardhat-plugin</code> ships a complete
        mock of the threshold network that runs locally — in tests, in
        dev, anywhere. We have 154 contract tests that exercise real
        FHE flows without touching a real threshold operator. That
        completeness is what let us actually ship a full product
        surface instead of one well-tested feature.
      </p>

      <h2>Where Fhenix is still maturing, honestly</h2>
      <p>
        This wouldn't be a credible post if we didn't name the gaps.
      </p>
      <p>
        <strong>Threshold operator decentralization.</strong> Today the
        operator set is small enough that "trust the operators" is a
        meaningful trust assumption. Fhenix has been clear about the
        decentralization roadmap, and we trust the direction, but the
        mainnet-ready answer to "is the operator set sufficiently
        decentralised" is: not yet. We're testnet-only because of
        this (and because of audits — see the roadmap).
      </p>
      <p>
        <strong>Decryption latency.</strong> Threshold decryption on
        testnet takes long enough that we had to design the UX around
        it — showing last-known plaintext optimistically, treating
        decrypt as async, never blocking the screen on it. On mainnet
        performance targets will tighten; on testnet today it's the
        single biggest UX constraint we work against.
      </p>
      <p>
        <strong>Maturity of the broader ecosystem.</strong> Fhenix's
        own SDKs are excellent. The wider tooling — wallet integrations
        that natively understand FHE handles, indexers that can mirror
        encrypted state, audit firms with FHE-specific expertise — is
        thin. Anyone shipping in this space is partly building tooling
        for the next person. We accept that and we publish what we
        learn.
      </p>

      <h2>Why we still picked it knowing all this</h2>
      <p>
        Every infrastructure choice is a bet. The bet here:
      </p>
      <ol>
        <li>
          <strong>Co-processor architecture is the right shape.</strong>{" "}
          Application builders who want to ship privacy on top of
          Ethereum (not <em>instead of</em> it) have one architectural
          path that doesn't require porting users to a new chain.
          Fhenix is shipping that path on a public testnet today,
          which is what we needed.
        </li>
        <li>
          <strong>The API design holds up under real use.</strong>{" "}
          <code>FHE.select</code>-over-revert, the four-tier ACL,
          context-bound input verification, TFHE in the browser — each
          of these is a deliberate, security-aware choice, and the way
          they compose across a real codebase is what convinced us the
          bigger architectural calls were equally considered.
        </li>
        <li>
          <strong>The trust gap closes from where it is.</strong>{" "}
          Threshold operator decentralisation is hard but it's a
          well-understood problem. Mainnet-ready FHE means a more
          decentralised operator set; that's on Fhenix's roadmap and
          we believe they'll get there. The harder bet — that FHE
          can be made practical at all — was already won by the time
          we picked.
        </li>
      </ol>

      <h2>What this enables for Blank</h2>
      <p>
        Concretely, choosing Fhenix gave us:
      </p>
      <ul>
        <li>
          A payment app where amounts are encrypted but the rest of
          Ethereum still works. Wallets, addresses, etherscan,
          composability — all untouched.
        </li>
        <li>
          A shared encrypted vault that every product surface plugs
          into via the same primitives. We didn't have to invent the
          encryption layer; we got to spend our engineering on what
          to do with it.
        </li>
        <li>
          A path forward. As the threshold network decentralises and
          decryption gets faster, every feature we've already shipped
          benefits — we don't have to migrate.
        </li>
      </ul>

      <h2>For other builders</h2>
      <p>
        If you're choosing an FHE stack right now: the decision rule
        we'd offer is the same as in our <a href="/blog/fhe-vs-zk">FHE-vs-ZK
        post</a>. Start from your problem.
      </p>
      <ul>
        <li>
          Building a payment app, a confidential DeFi primitive, or
          anything where you want to live on Ethereum and have one
          field be private? <strong>Co-processor architecture. Fhenix
          CoFHE today.</strong>
        </li>
        <li>
          Building a privacy L1 where every transaction is private by
          default and you don't need Ethereum compatibility?{" "}
          <strong>An FHE L1 (Inco, parts of Zama's roadmap).</strong>
        </li>
        <li>
          Building a research project on raw FHE primitives? <strong>
          Zama's TFHE-rs.</strong> Excellent library, no chain
          opinions.
        </li>
      </ul>
      <p>
        We're not the right team to tell anyone "build on Fhenix
        because Fhenix." We are the right team to tell you that for
        the specific shape of problem we have — encrypted amounts on
        Ethereum, with all of Ethereum's tooling intact — Fhenix's
        co-processor architecture is the right answer, the API design
        is the right shape, and the trade-offs we accept are ones we
        knowingly accept.
      </p>
      <p>
        Every wave we ship, we think we picked right.
      </p>
    </>
  ),
};

export default post;
