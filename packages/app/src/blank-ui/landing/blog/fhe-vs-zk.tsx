import type { BlogPost } from "./posts";

const post: BlogPost = {
  slug: "fhe-vs-zk",
  title: "Choosing FHE over zero-knowledge for the specific shape of problem we have",
  date: "2026-05-01",
  summary:
    "ZK proves statements about hidden data. FHE computes on hidden data. Different verbs, different problems. Here's why we picked FHE for amount-private payments.",
  author: "The Blank team",
  category: "deep-dive",
  readingTimeMin: 7,
  content: () => (
    <>
      <p>
        Anyone who's looked at Blank for more than five minutes has
        asked the same question: <em>why FHE and not zero-knowledge?</em>{" "}
        It's a fair question — both are real privacy primitives, both
        are deployed in production today, and both can give you "private
        amounts on a public chain" if you squint. But they're not
        interchangeable. They're different verbs. Picking the right one
        for a problem matters more than picking the trendier one.
      </p>

      <h2>The two tools, in plain terms</h2>
      <p>
        <strong>Zero-knowledge proofs</strong> let you prove a statement
        about hidden data without revealing the data. "I know an{" "}
        <code>X</code> such that <code>f(X) = y</code>" — the verifier
        sees the proof and the output, never the input. ZK is a{" "}
        <em>communication primitive</em>: it compresses what's
        verifiable.
      </p>
      <p>
        <strong>Fully homomorphic encryption</strong> lets you compute
        on encrypted data without decrypting it. The chain holds
        ciphertext; operations transform ciphertext into ciphertext;
        only a key-holder can decrypt the result. FHE is a{" "}
        <em>computation primitive</em>: it expands what's executable
        on hidden values.
      </p>
      <p>
        That phrasing — communication vs. computation — is the cleanest
        way to keep them apart. ZK proves things <em>about</em> hidden
        data. FHE computes <em>on</em> hidden data. If your problem
        decomposes to "I have a number, the chain needs to add it,
        compare it, and move it around, and then someone needs to
        decrypt the answer" — that's a computation problem. If it
        decomposes to "I have a secret, I need to convince someone of
        a statement about it" — that's a communication problem.
      </p>

      <h2>The shape of our problem</h2>
      <p>
        Blank is a payment app. Concretely, the operations the chain
        has to perform on an amount:
      </p>
      <ul>
        <li>
          <strong>Add</strong> it to a recipient's balance and{" "}
          <strong>subtract</strong> it from a sender's balance
        </li>
        <li>
          <strong>Compare</strong> it against an expected amount (for
          invoice escrow: "did the client pay the right number?")
        </li>
        <li>
          <strong>Conditionally select</strong> between two transfer
          paths based on the comparison (release on match, refund on
          mismatch)
        </li>
        <li>
          <strong>Decrypt</strong> for the sender + recipient at the
          end, so they can see the value
        </li>
      </ul>
      <p>
        Three of those four are <em>computations on the hidden value</em>.
        The fourth is decryption for the legitimate parties. None of
        them is "prove a statement about the value to a third party."
      </p>
      <p>
        That's the diagnostic. Our verbs are <code>add</code>,{" "}
        <code>compare</code>, <code>select</code>, <code>decrypt</code>.
        Not <code>prove</code>.
      </p>

      <h2>What a ZK design would look like</h2>
      <p>
        The ZK shape for private payments has been built before, more
        than once. Aztec ran a privacy L2 (now pivoted to a rollup) on
        this model. zkBob runs a shielded pool on Ethereum L1. Tornado
        Cash (sanctioned in 2022) was the canonical example for mixing.
        The pattern across all of them:
      </p>
      <ol>
        <li>
          The chain holds a Merkle tree of <strong>commitments</strong>{" "}
          to balances or notes — opaque hashes, not the values themselves.
        </li>
        <li>
          To transfer, the sender generates a ZK proof: "I know a leaf
          in the tree, with my commitment, that I'm spending; here's
          the new commitment that replaces it; the math balances."
        </li>
        <li>
          The chain verifies the proof and updates the tree. It never
          sees the value, the sender, or the recipient — just opaque
          hashes.
        </li>
      </ol>
      <p>
        This works. It also has a strong property we don't actually
        want: <strong>sender and receiver are also hidden</strong>.
        That's why mixers got the regulatory treatment they did — when
        you can't tell who paid whom, it's hard to comply with travel
        rules, OFAC sanctions screening, or basic accounting. Aztec
        and zkBob have well-thought-out compliance stories, but
        they're working uphill against the default behaviour of the
        primitive.
      </p>
      <p>
        For our wedge — freelancers and small businesses who want
        private invoicing — sender-and-receiver privacy is actively
        wrong. The freelancer <em>wants</em> the chain to record that
        their client paid them. The auditor needs to see the
        counterparty link. The IRS, eventually, will too. What the
        freelancer doesn't want is for competitors to see their rates
        on Etherscan.
      </p>

      <h2>What an FHE design looks like</h2>
      <p>
        With FHE, the chain stores the balance as a ciphertext —
        specifically <code>euint64</code> in Fhenix's CoFHE — bound to
        an address that's public. Operations:
      </p>
      <ul>
        <li>
          <strong>Subtract:</strong> <code>FHE.sub(senderBalance, amount)</code>{" "}
          produces a new ciphertext. The chain stores it. No plaintext.
        </li>
        <li>
          <strong>Add:</strong> <code>FHE.add(recipientBalance, amount)</code>.
          Same — ciphertext in, ciphertext out.
        </li>
        <li>
          <strong>Compare:</strong> <code>FHE.eq(escrowedAmount, expectedAmount)</code>{" "}
          returns an encrypted boolean (<code>ebool</code>) the chain can
          act on without decrypting.
        </li>
        <li>
          <strong>Conditional select:</strong>{" "}
          <code>FHE.select(matched, releasePath, refundPath)</code>{" "}
          picks one of two transfer paths based on the encrypted
          comparison result. The branch itself is hidden.
        </li>
        <li>
          <strong>Decrypt:</strong> the legitimate parties (sender +
          recipient, set via <code>FHE.allow</code>) ask Fhenix's
          threshold network for permits and decrypt locally.
        </li>
      </ul>
      <p>
        The state itself is encrypted. There's no commitment scheme
        on top. There's no separate shielded pool. Sender and
        receiver are public — they're just the <code>msg.sender</code>{" "}
        and the recipient address, like any normal ERC-20 transfer.
      </p>
      <p>
        And critically: the encrypted balance composes with everything
        else. A regular EOA can hold a regular ERC-20 alongside an
        encrypted balance. A regular smart contract can call into
        Blank's vault and transact (with the right permits). There's
        no bridge in, no bridge out, no separate world.
      </p>

      <h2>The trade-offs we're paying for that fit</h2>
      <p>
        FHE doesn't win on every axis. The honest list of what we give
        up:
      </p>
      <ul>
        <li>
          <strong>Speed.</strong> FHE operations are slow — each one
          is orders of magnitude slower than a regular EVM opcode.
          Threshold decryption adds 60–180 seconds on Sepolia today.
          Modern ZK proof systems verify in milliseconds (proving is
          slow but it happens off-chain). For "compute on encrypted
          data once and forget" workloads, ZK is much faster.
        </li>
        <li>
          <strong>Trust assumption.</strong> Decryption goes through
          Fhenix's threshold network — a t-of-n committee of operators.
          You trust the majority isn't colluding. ZK with STARKs has
          no comparable trust assumption (the proof is information-
          theoretically sound). ZK with SNARKs has trusted-setup
          assumptions that vary by system. Today, FHE's trust profile
          is closer to a federated set of validators; ZK's is closer
          to math.
        </li>
        <li>
          <strong>Maturity.</strong> ZK shipped real shielded pools
          years ago. FHE on smart contracts is roughly 12–18 months
          into production. The tooling, audit ecosystem, and library
          quality reflect that gap. We're early adopters and we know it.
        </li>
        <li>
          <strong>Sender/receiver privacy.</strong> If your problem
          actually needs that — if you're building anonymous donations,
          or whistleblower payments, or genuinely uncorrelated
          transactions — FHE doesn't give you that for free. ZK with
          a shielded pool does.
        </li>
      </ul>

      <h2>Where ZK wins, plainly</h2>
      <p>
        We picked FHE for our problem. We'd pick ZK for several others:
      </p>
      <ul>
        <li>
          <strong>Anonymous payments.</strong> Mixers, donation pools,
          private transfers where unlinkability is the goal. Shielded
          pools.
        </li>
        <li>
          <strong>Verifiable computation.</strong> "I ran this program
          on this input; here's the output; trust me." zkVMs (RiscZero,
          SP1, Jolt) make this practical for arbitrary code.
        </li>
        <li>
          <strong>Rollup validity proofs.</strong> A sequencer proves
          the next state root is correct. zkSync, Polygon zkEVM,
          StarkNet. FHE doesn't apply here.
        </li>
        <li>
          <strong>Anywhere "prove once, verify often" is the workload.</strong>{" "}
          Generate one expensive proof, broadcast it, every verifier
          checks it cheaply. ZK is built for this. FHE isn't.
        </li>
      </ul>

      <h2>Could we mix the two?</h2>
      <p>
        Yes, and people are. You can use FHE for the encrypted
        compute and ZK to prove that the FHE operations were applied
        correctly (some research designs do exactly this). For our
        threat model that's overkill — the FHE operations are
        executed by the EVM itself, which is already trustlessly
        verified by Ethereum's consensus. We don't need a second
        proof layer over the same execution.
      </p>
      <p>
        The combination becomes interesting if and when threshold
        decryption decentralizes far enough that we want a ZK proof
        of "the operators followed the protocol." That's a Wave-N
        problem, not a Wave-3 problem.
      </p>

      <h2>The actual decision rule</h2>
      <p>
        If you're building privacy on-chain and trying to pick:
      </p>
      <ul>
        <li>
          Does your problem look like "compute on a hidden value"
          (add, subtract, compare, conditional)? <strong>FHE.</strong>
        </li>
        <li>
          Does your problem look like "prove a statement about a hidden
          value to someone who doesn't have it" (set membership,
          range, knowledge of preimage)? <strong>ZK.</strong>
        </li>
        <li>
          Do you need both sender/receiver and amount hidden?{" "}
          <strong>ZK with a shielded pool.</strong>
        </li>
        <li>
          Do you need only the amount hidden, with sender/receiver
          public for compliance + composability? <strong>FHE.</strong>
        </li>
      </ul>
      <p>
        For our wedge — private invoicing for freelancers and teams —
        the diagnostic comes out FHE every time. So that's what we ship.
        Anyone telling you "X is better than Y" without naming the
        problem is selling X.
      </p>
    </>
  ),
};

export default post;
