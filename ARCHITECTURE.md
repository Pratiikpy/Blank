# Architecture — Encrypted Payment Super-App

## System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         FRONTEND                                  │
│  React 18 + Vite + @cofhe/react + wagmi + Framer Motion          │
│  Styling: Tailwind CSS + Custom Glass Design System               │
│  Deployed on: Vercel                                              │
├──────────────────────────────────────────────────────────────────┤
│                     @cofhe/sdk + @cofhe/react                     │
│  Encryption (TFHE WASM) → ZK Proof → Verify → Submit to chain   │
│  Decryption: Threshold Network → Unseal with permit keypair      │
├──────────────────────────────────────────────────────────────────┤
│                      SMART CONTRACTS                              │
│  Chain: Base Sepolia (84532)                                      │
│  Framework: Hardhat + cofhe-hardhat-plugin                        │
│  Library: @fhenixprotocol/cofhe-contracts (FHE.sol)              │
├──────────────────────────────────────────────────────────────────┤
│                     CoFHE COPROCESSOR                             │
│  API: testnet-cofhe.fhenix.zone                                   │
│  Verifier: testnet-cofhe-vrf.fhenix.zone                         │
│  Threshold: testnet-cofhe-tn.fhenix.zone                         │
└──────────────────────────────────────────────────────────────────┘
```

---

## SMART CONTRACT ARCHITECTURE

### Contract Dependency Graph

```
                    ┌──────────────────┐
                    │  FHERC20Vault.sol │  ← Foundation. Every other contract calls this.
                    │  (one per token)  │
                    └────────┬─────────┘
                             │
          ┌──────────────────┼──────────────────────┐
          │                  │                       │
    ┌─────▼─────┐    ┌──────▼──────┐    ┌──────────▼──────────┐
    │ PaymentHub │    │GroupManager │    │    BusinessHub       │
    │  .sol      │    │   .sol      │    │      .sol            │
    │            │    │             │    │                      │
    │ - send     │    │ - splits    │    │ - invoice            │
    │ - request  │    │ - group fund│    │ - payroll            │
    │ - batch    │    │ - settle    │    │ - escrow             │
    └────────────┘    └─────────────┘    └──────────────────────┘
          │
    ┌─────▼──────┐    ┌─────────────┐    ┌─────────────────────┐
    │ CreatorHub │    │ P2PExchange │    │  InheritanceManager  │
    │   .sol     │    │    .sol     │    │       .sol           │
    │            │    │             │    │                      │
    │ - tip      │    │ - offer     │    │ - set heir           │
    │ - tiers    │    │ - take      │    │ - heartbeat          │
    │ - profile  │    │ - atomic    │    │ - claim              │
    └────────────┘    └─────────────┘    └─────────────────────┘
```

---

### Contract 1: FHERC20Vault.sol

The foundation. One instance deployed per supported token (USDC, ETH, DAI).

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract FHERC20Vault {
    using SafeERC20 for IERC20;

    // --- State ---
    IERC20 public immutable underlyingToken;
    string public name;
    string public symbol;
    uint8 public decimals;

    mapping(address => euint64) private _encBalances;      // PRIVATE — never public
    mapping(address => mapping(address => euint64)) private _encAllowances;

    // --- Events (public context, NO amounts) ---
    event Shielded(address indexed user, uint256 timestamp);
    event Unshielded(address indexed user, uint256 timestamp);
    event EncTransfer(address indexed from, address indexed to, uint256 timestamp);
    event EncApproval(address indexed owner, address indexed spender, uint256 timestamp);

    // --- Core Functions ---

    // Shield: deposit ERC20 → get encrypted balance
    function shield(uint256 amount) external {
        underlyingToken.safeTransferFrom(msg.sender, address(this), amount);
        euint64 encAmount = FHE.asEuint64(amount);
        _encBalances[msg.sender] = FHE.add(_encBalances[msg.sender], encAmount);
        FHE.allowThis(_encBalances[msg.sender]);
        FHE.allowSender(_encBalances[msg.sender]);
        emit Shielded(msg.sender, block.timestamp);
    }

    // Unshield: burn encrypted balance → get ERC20 back
    // Two-step: requestUnshield → claimUnshield (async decrypt)
    function requestUnshield(InEuint64 calldata encAmount) external {
        euint64 amount = FHE.asEuint64(encAmount);
        ebool hasEnough = FHE.gte(_encBalances[msg.sender], amount);
        FHE.req(hasEnough);
        _encBalances[msg.sender] = FHE.sub(_encBalances[msg.sender], amount);
        FHE.allowThis(_encBalances[msg.sender]);
        FHE.allowSender(_encBalances[msg.sender]);
        // Store pending unshield for async decrypt
        _pendingUnshields[msg.sender] = amount;
        FHE.decrypt(amount); // Async — result available later
        emit Unshielded(msg.sender, block.timestamp);
    }

    function claimUnshield() external {
        euint64 pending = _pendingUnshields[msg.sender];
        (uint256 plainAmount, bool ready) = FHE.getDecryptResultSafe(pending);
        require(ready, "Decryption not ready");
        delete _pendingUnshields[msg.sender];
        underlyingToken.safeTransfer(msg.sender, plainAmount);
    }

    // Encrypted transfer
    function transfer(address to, InEuint64 calldata encAmount) external {
        euint64 amount = FHE.asEuint64(encAmount);
        ebool hasEnough = FHE.gte(_encBalances[msg.sender], amount);
        FHE.req(hasEnough);

        _encBalances[msg.sender] = FHE.sub(_encBalances[msg.sender], amount);
        _encBalances[to] = FHE.add(_encBalances[to], amount);

        // Access control — CRITICAL
        FHE.allowThis(_encBalances[msg.sender]);
        FHE.allowSender(_encBalances[msg.sender]);
        FHE.allowThis(_encBalances[to]);
        FHE.allow(_encBalances[to], to);

        emit EncTransfer(msg.sender, to, block.timestamp);
    }

    // Encrypted transferFrom (for contracts that need to move tokens on behalf of user)
    function transferFrom(address from, address to, InEuint64 calldata encAmount) external {
        euint64 amount = FHE.asEuint64(encAmount);

        ebool hasAllowance = FHE.gte(_encAllowances[from][msg.sender], amount);
        ebool hasBalance = FHE.gte(_encBalances[from], amount);
        FHE.req(FHE.and(hasAllowance, hasBalance));

        _encAllowances[from][msg.sender] = FHE.sub(_encAllowances[from][msg.sender], amount);
        _encBalances[from] = FHE.sub(_encBalances[from], amount);
        _encBalances[to] = FHE.add(_encBalances[to], amount);

        // Access control
        FHE.allowThis(_encBalances[from]);
        FHE.allow(_encBalances[from], from);
        FHE.allowThis(_encBalances[to]);
        FHE.allow(_encBalances[to], to);
        FHE.allowThis(_encAllowances[from][msg.sender]);
        FHE.allow(_encAllowances[from][msg.sender], from);

        emit EncTransfer(from, to, block.timestamp);
    }

    // Approve spender
    function approve(address spender, InEuint64 calldata encAmount) external {
        euint64 amount = FHE.asEuint64(encAmount);
        _encAllowances[msg.sender][spender] = amount;
        FHE.allowThis(_encAllowances[msg.sender][spender]);
        FHE.allow(_encAllowances[msg.sender][spender], spender);
        FHE.allowSender(_encAllowances[msg.sender][spender]);
        emit EncApproval(msg.sender, spender, block.timestamp);
    }

    // View encrypted balance — returns ciphertext handle (unseal with permit)
    function balanceOf(address account) external view returns (euint64) {
        return _encBalances[account];
    }

    // Internal transfer (used by other contracts via interface)
    function _internalTransfer(address from, address to, euint64 amount) internal {
        ebool hasEnough = FHE.gte(_encBalances[from], amount);
        FHE.req(hasEnough);
        _encBalances[from] = FHE.sub(_encBalances[from], amount);
        _encBalances[to] = FHE.add(_encBalances[to], amount);
        FHE.allowThis(_encBalances[from]);
        FHE.allow(_encBalances[from], from);
        FHE.allowThis(_encBalances[to]);
        FHE.allow(_encBalances[to], to);
        emit EncTransfer(from, to, block.timestamp);
    }
}
```

**Gas estimate per function:**
- `shield()`: ~300K (asEuint64) + ~175K (add) + ~150K (allowThis+allowSender) = ~625K
- `transfer()`: ~300K (asEuint64) + ~125K (gte) + ~150K (req) + ~175K (sub) + ~175K (add) + ~300K (allows) = ~1.2M
- `balanceOf()`: ~0 (just returns handle)

---

### Contract 2: PaymentHub.sol

Handles: P2P payments with notes, payment requests, batch sends.

```solidity
contract PaymentHub {
    struct PaymentRequest {
        address from;         // Who should pay
        address to;           // Who gets paid
        euint64 amount;       // Encrypted amount
        address token;        // Which FHERC20Vault
        string note;          // Public note
        bool fulfilled;
        bool cancelled;
    }

    uint256 public nextRequestId;
    mapping(uint256 => PaymentRequest) public requests;
    mapping(address => uint256[]) public userRequests;    // Requests TO this user
    mapping(address => uint256[]) public userSentRequests; // Requests FROM this user

    // Events — PUBLIC context, PRIVATE amounts
    event PaymentSent(address indexed from, address indexed to, address token, string note, uint256 timestamp);
    event RequestCreated(uint256 indexed requestId, address indexed from, address indexed to, string note, uint256 timestamp);
    event RequestFulfilled(uint256 indexed requestId, uint256 timestamp);
    event RequestCancelled(uint256 indexed requestId, uint256 timestamp);

    // --- P2P Payment with Note ---
    function sendPayment(
        address to,
        address vaultAddress,
        InEuint64 calldata encAmount,
        string calldata note
    ) external {
        FHERC20Vault vault = FHERC20Vault(vaultAddress);
        vault.transferFrom(msg.sender, to, encAmount);
        emit PaymentSent(msg.sender, to, vaultAddress, note, block.timestamp);
    }

    // --- Payment Request ---
    function createRequest(
        address from,
        address vaultAddress,
        InEuint64 calldata encAmount,
        string calldata note
    ) external {
        euint64 amount = FHE.asEuint64(encAmount);
        FHE.allowThis(amount);
        FHE.allow(amount, from); // Payer can see the amount

        uint256 id = nextRequestId++;
        requests[id] = PaymentRequest({
            from: from,
            to: msg.sender,
            amount: amount,
            token: vaultAddress,
            note: note,
            fulfilled: false,
            cancelled: false
        });
        userRequests[from].push(id);
        userSentRequests[msg.sender].push(id);

        emit RequestCreated(id, from, msg.sender, note, block.timestamp);
    }

    function fulfillRequest(uint256 requestId) external {
        PaymentRequest storage req = requests[requestId];
        require(msg.sender == req.from, "Not the payer");
        require(!req.fulfilled && !req.cancelled, "Already processed");

        FHERC20Vault vault = FHERC20Vault(req.token);
        // Transfer encrypted amount from payer to payee
        // Using internal transfer with the stored encrypted amount
        vault._internalTransfer(msg.sender, req.to, req.amount);
        req.fulfilled = true;

        emit RequestFulfilled(requestId, block.timestamp);
    }

    function cancelRequest(uint256 requestId) external {
        PaymentRequest storage req = requests[requestId];
        require(msg.sender == req.to, "Not the requester");
        require(!req.fulfilled && !req.cancelled, "Already processed");
        req.cancelled = true;
        emit RequestCancelled(requestId, block.timestamp);
    }

    // --- Batch Send ---
    function batchSend(
        address[] calldata recipients,
        address vaultAddress,
        InEuint64[] calldata amounts,
        string[] calldata notes
    ) external {
        require(recipients.length == amounts.length, "Length mismatch");
        FHERC20Vault vault = FHERC20Vault(vaultAddress);
        for (uint256 i = 0; i < recipients.length; i++) {
            vault.transferFrom(msg.sender, recipients[i], amounts[i]);
            emit PaymentSent(msg.sender, recipients[i], vaultAddress, notes[i], block.timestamp);
        }
    }

    // --- View Functions ---
    function getRequestsForUser(address user) external view returns (uint256[] memory) {
        return userRequests[user];
    }

    function getSentRequestsForUser(address user) external view returns (uint256[] memory) {
        return userSentRequests[user];
    }
}
```

---

### Contract 3: GroupManager.sol

```solidity
contract GroupManager {
    struct Group {
        string name;
        address[] members;
        mapping(address => bool) isMember;
        mapping(address => euint64) debts; // Net debt per member (encrypted)
        uint256 expenseCount;
    }

    struct Expense {
        address payer;
        string description;
        uint256 timestamp;
    }

    uint256 public nextGroupId;
    mapping(uint256 => Group) private groups;
    mapping(uint256 => mapping(uint256 => Expense)) public expenses;

    event GroupCreated(uint256 indexed groupId, string name, address[] members);
    event ExpenseAdded(uint256 indexed groupId, uint256 expenseId, address payer, string description, uint256 timestamp);
    event DebtSettled(uint256 indexed groupId, address from, address to, uint256 timestamp);
    event FundDeposited(uint256 indexed groupId, address depositor, uint256 timestamp);

    function createGroup(string calldata name, address[] calldata members) external returns (uint256) {
        uint256 id = nextGroupId++;
        Group storage g = groups[id];
        g.name = name;
        g.members = members;
        for (uint256 i = 0; i < members.length; i++) {
            g.isMember[members[i]] = true;
            g.debts[members[i]] = FHE.asEuint64(0);
            FHE.allowThis(g.debts[members[i]]);
            FHE.allow(g.debts[members[i]], members[i]);
        }
        emit GroupCreated(id, name, members);
        return id;
    }

    // Add expense with custom encrypted splits per person
    function addExpense(
        uint256 groupId,
        address[] calldata splitWith,
        InEuint64[] calldata shares,      // Encrypted amount each person owes
        InEuint64 calldata totalPaid,     // What the payer paid
        string calldata description
    ) external {
        Group storage g = groups[groupId];
        require(g.isMember[msg.sender], "Not a member");
        require(splitWith.length == shares.length, "Length mismatch");

        // Payer gets credit (subtract from their debt)
        euint64 total = FHE.asEuint64(totalPaid);
        g.debts[msg.sender] = FHE.sub(g.debts[msg.sender], total);
        FHE.allowThis(g.debts[msg.sender]);
        FHE.allow(g.debts[msg.sender], msg.sender);

        // Each person gets their share added to their debt
        for (uint256 i = 0; i < splitWith.length; i++) {
            require(g.isMember[splitWith[i]], "Not a member");
            euint64 share = FHE.asEuint64(shares[i]);
            g.debts[splitWith[i]] = FHE.add(g.debts[splitWith[i]], share);
            FHE.allowThis(g.debts[splitWith[i]]);
            FHE.allow(g.debts[splitWith[i]], splitWith[i]);
        }

        uint256 expenseId = g.expenseCount++;
        expenses[groupId][expenseId] = Expense(msg.sender, description, block.timestamp);
        emit ExpenseAdded(groupId, expenseId, msg.sender, description, block.timestamp);
    }

    // Settle debt with another member via FHERC20 transfer
    function settleDebt(
        uint256 groupId,
        address with_,
        address vaultAddress,
        InEuint64 calldata encAmount
    ) external {
        Group storage g = groups[groupId];
        require(g.isMember[msg.sender] && g.isMember[with_], "Not members");

        // Transfer payment
        FHERC20Vault(vaultAddress).transferFrom(msg.sender, with_, encAmount);

        // Update debts
        euint64 amount = FHE.asEuint64(encAmount);
        g.debts[msg.sender] = FHE.sub(g.debts[msg.sender], amount);
        g.debts[with_] = FHE.add(g.debts[with_], amount);

        FHE.allowThis(g.debts[msg.sender]);
        FHE.allow(g.debts[msg.sender], msg.sender);
        FHE.allowThis(g.debts[with_]);
        FHE.allow(g.debts[with_], with_);

        emit DebtSettled(groupId, msg.sender, with_, block.timestamp);
    }

    // View your own debt (encrypted — unseal with permit)
    function getMyDebt(uint256 groupId) external view returns (euint64) {
        return groups[groupId].debts[msg.sender];
    }

    function getGroupMembers(uint256 groupId) external view returns (address[] memory) {
        return groups[groupId].members;
    }
}
```

---

### Contract 4: CreatorHub.sol

```solidity
contract CreatorHub {
    struct CreatorProfile {
        string name;
        string bio;
        uint64 tier1Threshold;   // Bronze threshold (plaintext — public)
        uint64 tier2Threshold;   // Silver threshold
        uint64 tier3Threshold;   // Gold threshold
        euint64 totalEarnings;   // Encrypted total
        uint256 supporterCount;  // Public count
        bool active;
    }

    mapping(address => CreatorProfile) public profiles;
    mapping(address => mapping(address => euint64)) private _supporterContributions; // creator → supporter → encrypted total

    event ProfileCreated(address indexed creator, string name);
    event Supported(address indexed supporter, address indexed creator, string message, uint256 timestamp);

    function createProfile(
        string calldata name,
        string calldata bio,
        uint64 tier1,
        uint64 tier2,
        uint64 tier3
    ) external {
        profiles[msg.sender] = CreatorProfile({
            name: name,
            bio: bio,
            tier1Threshold: tier1,
            tier2Threshold: tier2,
            tier3Threshold: tier3,
            totalEarnings: FHE.asEuint64(0),
            supporterCount: 0,
            active: true
        });
        FHE.allowThis(profiles[msg.sender].totalEarnings);
        FHE.allow(profiles[msg.sender].totalEarnings, msg.sender);
        emit ProfileCreated(msg.sender, name);
    }

    function support(
        address creator,
        address vaultAddress,
        InEuint64 calldata encAmount,
        string calldata message
    ) external {
        require(profiles[creator].active, "Creator not active");

        // Transfer encrypted tokens to creator
        FHERC20Vault(vaultAddress).transferFrom(msg.sender, creator, encAmount);

        euint64 amount = FHE.asEuint64(encAmount);

        // Update encrypted totals
        profiles[creator].totalEarnings = FHE.add(profiles[creator].totalEarnings, amount);
        _supporterContributions[creator][msg.sender] = FHE.add(
            _supporterContributions[creator][msg.sender],
            amount
        );

        // First-time supporter
        if (FHE.decrypt(_supporterContributions[creator][msg.sender]) == 0) {
            // NOTE: Can't use decrypt like this in production.
            // Instead, track supporter count separately.
        }
        profiles[creator].supporterCount++;

        // Access control
        FHE.allowThis(profiles[creator].totalEarnings);
        FHE.allow(profiles[creator].totalEarnings, creator);
        FHE.allowThis(_supporterContributions[creator][msg.sender]);
        FHE.allow(_supporterContributions[creator][msg.sender], msg.sender);

        emit Supported(msg.sender, creator, message, block.timestamp);
    }

    // Check tier (returns encrypted booleans — supporter unseals to see their tier)
    function getMyTier(address creator) external view returns (ebool tier1, ebool tier2, ebool tier3) {
        euint64 contrib = _supporterContributions[creator][msg.sender];
        tier1 = FHE.gte(contrib, FHE.asEuint64(profiles[creator].tier1Threshold));
        tier2 = FHE.gte(contrib, FHE.asEuint64(profiles[creator].tier2Threshold));
        tier3 = FHE.gte(contrib, FHE.asEuint64(profiles[creator].tier3Threshold));
    }

    function getMyContribution(address creator) external view returns (euint64) {
        return _supporterContributions[creator][msg.sender];
    }

    function getCreatorEarnings() external view returns (euint64) {
        return profiles[msg.sender].totalEarnings;
    }
}
```

---

### Contract 5: BusinessHub.sol

```solidity
contract BusinessHub {
    // --- Invoice ---
    struct Invoice {
        address vendor;
        address client;
        euint64 amount;
        string description;
        uint256 dueDate;
        uint256 createdAt;
        bool paid;
        bool cancelled;
    }

    // --- Escrow ---
    struct Escrow {
        address depositor;
        address beneficiary;
        euint64 amount;
        address token;
        string description;
        bool depositorApproved;
        bool beneficiaryApproved;
        bool released;
        bool disputed;
    }

    uint256 public nextInvoiceId;
    uint256 public nextEscrowId;
    mapping(uint256 => Invoice) public invoices;
    mapping(uint256 => Escrow) public escrows;
    mapping(address => uint256[]) public vendorInvoices;
    mapping(address => uint256[]) public clientInvoices;

    event InvoiceCreated(uint256 indexed id, address indexed vendor, address indexed client, string description, uint256 dueDate);
    event InvoicePaid(uint256 indexed id, uint256 timestamp);
    event PayrollExecuted(address indexed employer, uint256 employeeCount, uint256 timestamp);
    event EscrowCreated(uint256 indexed id, address indexed depositor, address indexed beneficiary, string description);
    event EscrowApproved(uint256 indexed id, address approver);
    event EscrowReleased(uint256 indexed id);
    event EscrowDisputed(uint256 indexed id, address disputer);

    // --- Invoice Functions ---

    function createInvoice(
        address client,
        address vaultAddress,
        InEuint64 calldata encAmount,
        string calldata description,
        uint256 dueDate
    ) external returns (uint256) {
        euint64 amount = FHE.asEuint64(encAmount);
        FHE.allowThis(amount);
        FHE.allow(amount, client);      // Client can see amount
        FHE.allow(amount, msg.sender);  // Vendor can see amount

        uint256 id = nextInvoiceId++;
        invoices[id] = Invoice({
            vendor: msg.sender,
            client: client,
            amount: amount,
            description: description,
            dueDate: dueDate,
            createdAt: block.timestamp,
            paid: false,
            cancelled: false
        });
        vendorInvoices[msg.sender].push(id);
        clientInvoices[client].push(id);

        emit InvoiceCreated(id, msg.sender, client, description, dueDate);
        return id;
    }

    function payInvoice(uint256 invoiceId, address vaultAddress) external {
        Invoice storage inv = invoices[invoiceId];
        require(msg.sender == inv.client, "Not the client");
        require(!inv.paid && !inv.cancelled, "Already processed");

        // Transfer encrypted amount from client to vendor
        // Client must have approved this contract to spend their FHERC20
        FHERC20Vault vault = FHERC20Vault(vaultAddress);
        // Using the stored encrypted amount
        vault._internalTransfer(msg.sender, inv.vendor, inv.amount);
        inv.paid = true;

        emit InvoicePaid(invoiceId, block.timestamp);
    }

    // --- Payroll ---

    function runPayroll(
        address[] calldata employees,
        address vaultAddress,
        InEuint64[] calldata salaries
    ) external {
        require(employees.length == salaries.length, "Length mismatch");
        FHERC20Vault vault = FHERC20Vault(vaultAddress);
        for (uint256 i = 0; i < employees.length; i++) {
            vault.transferFrom(msg.sender, employees[i], salaries[i]);
        }
        emit PayrollExecuted(msg.sender, employees.length, block.timestamp);
    }

    // --- Escrow ---

    function createEscrow(
        address beneficiary,
        address vaultAddress,
        InEuint64 calldata encAmount,
        string calldata description
    ) external returns (uint256) {
        euint64 amount = FHE.asEuint64(encAmount);

        // Lock funds: transfer from depositor to this contract
        FHERC20Vault(vaultAddress).transferFrom(msg.sender, address(this), encAmount);

        FHE.allowThis(amount);
        FHE.allow(amount, msg.sender);
        FHE.allow(amount, beneficiary);

        uint256 id = nextEscrowId++;
        escrows[id] = Escrow({
            depositor: msg.sender,
            beneficiary: beneficiary,
            amount: amount,
            token: vaultAddress,
            description: description,
            depositorApproved: false,
            beneficiaryApproved: false,
            released: false,
            disputed: false
        });

        emit EscrowCreated(id, msg.sender, beneficiary, description);
        return id;
    }

    function approveEscrow(uint256 escrowId) external {
        Escrow storage e = escrows[escrowId];
        require(!e.released && !e.disputed, "Already resolved");

        if (msg.sender == e.depositor) e.depositorApproved = true;
        else if (msg.sender == e.beneficiary) e.beneficiaryApproved = true;
        else revert("Not a party");

        emit EscrowApproved(escrowId, msg.sender);

        // If both approved, release funds
        if (e.depositorApproved && e.beneficiaryApproved) {
            FHERC20Vault(e.token)._internalTransfer(address(this), e.beneficiary, e.amount);
            e.released = true;
            emit EscrowReleased(escrowId);
        }
    }

    function disputeEscrow(uint256 escrowId) external {
        Escrow storage e = escrows[escrowId];
        require(msg.sender == e.depositor || msg.sender == e.beneficiary, "Not a party");
        require(!e.released, "Already released");
        e.disputed = true;
        emit EscrowDisputed(escrowId, msg.sender);
        // In MVP: disputed funds stay locked. Future: add arbitration.
    }
}
```

---

### Contract 6: P2PExchange.sol

```solidity
contract P2PExchange {
    struct Offer {
        address maker;
        address tokenGive;      // FHERC20Vault address
        address tokenWant;      // FHERC20Vault address
        euint64 amountGive;     // Encrypted
        euint64 amountWant;     // Encrypted
        bool active;
        bool filled;
    }

    uint256 public nextOfferId;
    mapping(uint256 => Offer) public offers;

    event OfferCreated(uint256 indexed id, address indexed maker, address tokenGive, address tokenWant, uint256 timestamp);
    event OfferTaken(uint256 indexed id, address indexed taker, uint256 timestamp);
    event OfferCancelled(uint256 indexed id);

    function createOffer(
        address tokenGive,
        InEuint64 calldata encAmountGive,
        address tokenWant,
        InEuint64 calldata encAmountWant
    ) external returns (uint256) {
        euint64 amountGive = FHE.asEuint64(encAmountGive);
        euint64 amountWant = FHE.asEuint64(encAmountWant);

        // Lock maker's tokens
        FHERC20Vault(tokenGive).transferFrom(msg.sender, address(this), encAmountGive);

        FHE.allowThis(amountGive);
        FHE.allowThis(amountWant);

        uint256 id = nextOfferId++;
        offers[id] = Offer({
            maker: msg.sender,
            tokenGive: tokenGive,
            tokenWant: tokenWant,
            amountGive: amountGive,
            amountWant: amountWant,
            active: true,
            filled: false
        });

        emit OfferCreated(id, msg.sender, tokenGive, tokenWant, block.timestamp);
        return id;
    }

    function takeOffer(uint256 offerId, InEuint64 calldata encPayment) external {
        Offer storage o = offers[offerId];
        require(o.active && !o.filled, "Not available");

        // Taker sends tokenWant to maker
        FHERC20Vault(o.tokenWant).transferFrom(msg.sender, o.maker, encPayment);

        // Release locked tokenGive to taker
        FHERC20Vault(o.tokenGive)._internalTransfer(address(this), msg.sender, o.amountGive);

        o.filled = true;
        o.active = false;

        emit OfferTaken(offerId, msg.sender, block.timestamp);
    }

    function cancelOffer(uint256 offerId) external {
        Offer storage o = offers[offerId];
        require(msg.sender == o.maker, "Not maker");
        require(o.active && !o.filled, "Not available");

        // Return locked tokens to maker
        FHERC20Vault(o.tokenGive)._internalTransfer(address(this), msg.sender, o.amountGive);
        o.active = false;

        emit OfferCancelled(offerId);
    }
}
```

---

### Contract 7: InheritanceManager.sol

```solidity
contract InheritanceManager {
    struct Inheritance {
        address heir;
        uint256 inactivityPeriod; // seconds
        uint256 lastHeartbeat;
        bool active;
    }

    mapping(address => Inheritance) public inheritances;

    event HeirSet(address indexed owner, address indexed heir, uint256 inactivityPeriod);
    event Heartbeat(address indexed owner, uint256 timestamp);
    event InheritanceClaimed(address indexed owner, address indexed heir, uint256 timestamp);

    function setHeir(address heir, uint256 inactivityPeriod) external {
        require(heir != address(0) && heir != msg.sender, "Invalid heir");
        require(inactivityPeriod >= 30 days, "Min 30 days");
        inheritances[msg.sender] = Inheritance({
            heir: heir,
            inactivityPeriod: inactivityPeriod,
            lastHeartbeat: block.timestamp,
            active: true
        });
        emit HeirSet(msg.sender, heir, inactivityPeriod);
    }

    function heartbeat() external {
        require(inheritances[msg.sender].active, "No inheritance set");
        inheritances[msg.sender].lastHeartbeat = block.timestamp;
        emit Heartbeat(msg.sender, block.timestamp);
    }

    function claimInheritance(address owner, address[] calldata vaultAddresses) external {
        Inheritance storage inh = inheritances[owner];
        require(inh.active, "No inheritance");
        require(msg.sender == inh.heir, "Not the heir");
        require(block.timestamp > inh.lastHeartbeat + inh.inactivityPeriod, "Owner still active");

        // Transfer all encrypted balances from owner to heir
        for (uint256 i = 0; i < vaultAddresses.length; i++) {
            FHERC20Vault vault = FHERC20Vault(vaultAddresses[i]);
            euint64 balance = vault.balanceOf(owner);
            vault._internalTransfer(owner, msg.sender, balance);
        }

        inh.active = false;
        emit InheritanceClaimed(owner, msg.sender, block.timestamp);
    }
}
```

---

## FRONTEND ARCHITECTURE

### Project Structure

```
app/
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── layout.tsx                # Root layout + providers
│   │   ├── page.tsx                  # Landing page
│   │   ├── (auth)/                   # Pre-login routes
│   │   │   └── connect/page.tsx      # Wallet connect + onboarding
│   │   ├── (dashboard)/              # Post-login routes
│   │   │   ├── layout.tsx            # Dashboard layout (sidebar + bottomnav)
│   │   │   ├── page.tsx              # Home / Dashboard
│   │   │   ├── send/page.tsx         # Send money
│   │   │   ├── receive/page.tsx      # Receive / QR / Payment link
│   │   │   ├── request/page.tsx      # Payment requests
│   │   │   ├── groups/
│   │   │   │   ├── page.tsx          # Group list
│   │   │   │   ├── [id]/page.tsx     # Group detail
│   │   │   │   └── new/page.tsx      # Create group
│   │   │   ├── creators/
│   │   │   │   ├── page.tsx          # Browse creators
│   │   │   │   ├── [address]/page.tsx # Creator tip page
│   │   │   │   └── setup/page.tsx    # Create profile
│   │   │   ├── business/
│   │   │   │   ├── invoices/page.tsx
│   │   │   │   ├── payroll/page.tsx
│   │   │   │   ├── escrow/page.tsx
│   │   │   │   └── multisig/page.tsx
│   │   │   ├── exchange/page.tsx     # P2P exchange
│   │   │   ├── privacy/page.tsx      # Permits & sharing
│   │   │   └── settings/page.tsx     # Settings, inheritance, contacts
│   │   └── tip/[address]/page.tsx    # Public creator tip page (no auth needed)
│   │
│   ├── components/
│   │   ├── ui/                       # shadcn/ui components
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx           # Desktop sidebar nav
│   │   │   ├── BottomNav.tsx         # Mobile bottom nav
│   │   │   ├── Header.tsx
│   │   │   └── MobileDrawer.tsx
│   │   ├── wallet/
│   │   │   ├── ConnectButton.tsx     # Wallet connect
│   │   │   ├── BalanceDisplay.tsx    # Encrypted balance (tap to reveal)
│   │   │   ├── ShieldUnshield.tsx    # Shield/unshield UI
│   │   │   └── TokenSelector.tsx     # Token dropdown
│   │   ├── payment/
│   │   │   ├── SendForm.tsx          # Send money form
│   │   │   ├── RequestForm.tsx       # Request money form
│   │   │   ├── RequestCard.tsx       # Individual request display
│   │   │   ├── BatchSendForm.tsx
│   │   │   ├── QRGenerator.tsx
│   │   │   ├── QRScanner.tsx
│   │   │   └── PaymentConfirm.tsx    # Confirm + encrypt + send
│   │   ├── groups/
│   │   │   ├── GroupCard.tsx
│   │   │   ├── ExpenseForm.tsx
│   │   │   ├── SettleForm.tsx
│   │   │   └── MemberList.tsx
│   │   ├── creators/
│   │   │   ├── CreatorCard.tsx
│   │   │   ├── TipForm.tsx
│   │   │   ├── TierBadge.tsx
│   │   │   └── ProfileSetup.tsx
│   │   ├── business/
│   │   │   ├── InvoiceForm.tsx
│   │   │   ├── InvoiceCard.tsx
│   │   │   ├── PayrollForm.tsx
│   │   │   ├── EscrowCard.tsx
│   │   │   └── MultiSigProposal.tsx
│   │   ├── privacy/
│   │   │   ├── PermitList.tsx
│   │   │   ├── SharePermitForm.tsx
│   │   │   ├── ProveBalanceForm.tsx
│   │   │   └── RevokeButton.tsx
│   │   ├── activity/
│   │   │   ├── ActivityFeed.tsx      # Social feed
│   │   │   └── ActivityItem.tsx      # Single activity row
│   │   └── common/
│   │       ├── EncryptedAmount.tsx   # Shows ████ or revealed amount
│   │       ├── LoadingEncrypt.tsx    # Encryption progress steps
│   │       ├── AddressDisplay.tsx
│   │       └── EmptyState.tsx
│   │
│   ├── hooks/                        # Custom app hooks (wrapping @cofhe/react)
│   │   ├── useShield.ts
│   │   ├── useUnshield.ts
│   │   ├── useSendPayment.ts
│   │   ├── useRequestPayment.ts
│   │   ├── useGroupSplit.ts
│   │   ├── useTipCreator.ts
│   │   ├── useInvoice.ts
│   │   ├── useEscrow.ts
│   │   ├── useEncryptedBalance.ts    # Wraps useCofheTokenDecryptedBalance
│   │   └── useActivityFeed.ts        # Reads on-chain events
│   │
│   ├── lib/
│   │   ├── contracts.ts              # Contract addresses + ABIs
│   │   ├── cofhe-config.ts           # CofheProvider config
│   │   ├── wagmi-config.ts           # Wagmi config
│   │   ├── constants.ts              # Supported tokens, chain config
│   │   ├── utils.ts                  # Formatting, helpers
│   │   └── qr.ts                     # QR encode/decode helpers
│   │
│   ├── providers/
│   │   ├── WagmiProvider.tsx
│   │   ├── CofheProvider.tsx
│   │   ├── QueryProvider.tsx
│   │   └── AppProviders.tsx          # Wraps all providers
│   │
│   ├── stores/                       # Local state (Zustand or localStorage)
│   │   ├── contacts.ts               # Address book
│   │   ├── preferences.ts            # User settings
│   │   └── profile.ts                # User profile type (personal/creator/business)
│   │
│   └── types/
│       ├── contracts.ts              # Contract types (generated by typechain)
│       ├── payment.ts
│       ├── group.ts
│       └── creator.ts
│
├── contracts/                        # Hardhat project
│   ├── contracts/
│   │   ├── FHERC20Vault.sol
│   │   ├── PaymentHub.sol
│   │   ├── GroupManager.sol
│   │   ├── CreatorHub.sol
│   │   ├── BusinessHub.sol
│   │   ├── P2PExchange.sol
│   │   └── InheritanceManager.sol
│   ├── test/
│   │   ├── FHERC20Vault.test.ts
│   │   ├── PaymentHub.test.ts
│   │   ├── GroupManager.test.ts
│   │   ├── CreatorHub.test.ts
│   │   ├── BusinessHub.test.ts
│   │   ├── P2PExchange.test.ts
│   │   └── InheritanceManager.test.ts
│   ├── tasks/
│   │   ├── deploy-all.ts
│   │   └── utils.ts
│   ├── hardhat.config.ts
│   └── package.json
│
├── package.json                      # Root workspace
└── turbo.json                        # Monorepo config (optional)
```

---

## DATA ARCHITECTURE

### On-Chain State (Smart Contracts) — Source of Truth

All financial data lives on-chain. Encrypted by FHE.

| Data | Contract | Type | Who Can Read |
|------|----------|------|-------------|
| Token balances | FHERC20Vault | `euint64` | Owner only (via permit) |
| Payment requests | PaymentHub | `euint64` amount + plaintext metadata | Payer + payee |
| Group debts | GroupManager | `euint64` per member | Each member sees only theirs |
| Creator earnings | CreatorHub | `euint64` total | Creator only |
| Supporter contributions | CreatorHub | `euint64` per supporter | Each supporter sees only theirs |
| Invoice amounts | BusinessHub | `euint64` | Vendor + client |
| Escrow amounts | BusinessHub | `euint64` | Depositor + beneficiary |

### Off-Chain State (Client-Side Only)

NO backend server. Everything stored locally.

| Data | Storage | Why |
|------|---------|-----|
| Contacts/address book | localStorage | Personal preference, no privacy concern |
| User profile type | localStorage | Personal/Creator/Freelancer/Business |
| Permit cache | IndexedDB (cofhejs handles) | SDK manages automatically |
| UI preferences | localStorage | Theme, notifications, language |
| Decrypted balance cache | In-memory only (never persisted) | Security — don't write plaintext to disk |

### Event-Based Activity Feed

Activity feed is built from on-chain events. No backend indexing needed.

```typescript
// Frontend queries events directly from RPC
const events = await publicClient.getLogs({
  address: paymentHubAddress,
  event: parseAbiItem('event PaymentSent(address indexed from, address indexed to, address token, string note, uint256 timestamp)'),
  fromBlock: userFirstBlock, // Store this in localStorage
  toBlock: 'latest',
});
```

For performance: cache last-seen block number in localStorage. Only query new events.

---

## PROVIDER STACK

```tsx
// src/providers/AppProviders.tsx

<WagmiProvider config={wagmiConfig}>
  <QueryClientProvider client={queryClient}>
    <CofheProvider
      walletClient={walletClient}
      publicClient={publicClient}
      config={cofheConfig}
    >
      {children}
    </CofheProvider>
  </QueryClientProvider>
</WagmiProvider>
```

**cofheConfig:**
```typescript
import { createCofheConfig, baseSepolia } from '@cofhe/sdk/chains';

export const cofheConfig = createCofheConfig({
  supportedChains: [baseSepolia],
});
```

**wagmiConfig:**
```typescript
import { createConfig, http } from 'wagmi';
import { baseSepolia } from 'wagmi/chains';
import { coinbaseWallet, metaMask, walletConnect } from 'wagmi/connectors';

export const wagmiConfig = createConfig({
  chains: [baseSepolia],
  connectors: [metaMask(), coinbaseWallet({ appName: 'AppName' }), walletConnect({ projectId })],
  transports: { [baseSepolia.id]: http() },
});
```

---

## DEPLOYMENT PLAN

### Smart Contracts
1. Compile with Hardhat (`solidity 0.8.25`, `evmVersion: cancun`)
2. Test with mock contracts locally (`pnpm test`)
3. Deploy to Base Sepolia (`pnpm base-sepolia:deploy`)
4. Verify on block explorer
5. Export ABIs + addresses to frontend `lib/contracts.ts`

### Frontend
1. Next.js build
2. Deploy to Vercel
3. Environment variables: contract addresses, chain config (all public — no secrets)

### Contract Deployment Order
```
1. Deploy FHERC20Vault (for TestUSDC)
2. Deploy FHERC20Vault (for TestETH) — if needed
3. Deploy PaymentHub (pass vault addresses)
4. Deploy GroupManager (pass vault addresses)
5. Deploy CreatorHub (pass vault addresses)
6. Deploy BusinessHub (pass vault addresses)
7. Deploy P2PExchange (pass vault addresses)
8. Deploy InheritanceManager (pass vault addresses)
```

---

## BUILD ORDER (Priority Sequence)

### Phase 1: Foundation
1. FHERC20Vault.sol + tests
2. Frontend: wallet connect + shield/unshield + balance display

### Phase 2: Core Payments
3. PaymentHub.sol (send, request, batch) + tests
4. Frontend: send, receive, request, QR, payment links

### Phase 3: Social
5. GroupManager.sol + tests
6. CreatorHub.sol + tests
7. Frontend: groups, splits, creator tips, activity feed

### Phase 4: Business
8. BusinessHub.sol + tests
9. Frontend: invoices, payroll, escrow

### Phase 5: Advanced
10. P2PExchange.sol + tests
11. InheritanceManager.sol + tests
12. Frontend: exchange, inheritance, privacy controls

### Phase 6: Polish
13. Mobile responsive (bottom nav, drawer)
14. QR scanner (camera)
15. Export statements (PDF/CSV)
16. Contacts/address book

---

## FRONTEND TECH STACK (Updated After NullPay Study)

### Framework: React 18 + Vite (NOT Next.js)

**Why Vite over Next.js:** This is a client-side-only app. No SSR needed. No API routes. No server. The @cofhe/react SDK needs browser APIs (WASM, IndexedDB, window.ethereum). Vite is faster, simpler, and avoids hydration issues with wallet providers.

### Dependencies

```json
{
  "react": "^18.3.0",
  "react-dom": "^18.3.0",
  "react-router-dom": "^7.x",
  "typescript": "^5.5.0",
  "vite": "^6.x",
  "@cofhe/sdk": "^0.4.0",
  "@cofhe/react": "^0.4.0",
  "@cofhe/abi": "^0.4.0",
  "wagmi": "^2.x",
  "viem": "^2.x",
  "@tanstack/react-query": "^5.x",
  "framer-motion": "^12.x",
  "tailwindcss": "^3.4.x",
  "lucide-react": "^0.400+",
  "zustand": "^5.x",
  "qrcode.react": "^4.x",
  "react-hot-toast": "^2.x",
  "recharts": "^3.x",
  "jspdf": "^2.x",
  "date-fns": "^3.x",
  "clsx": "^2.x",
  "tailwind-merge": "^2.x"
}
```

### Design Reference

See `DESIGN_SYSTEM.md` for complete design specifications including:
- Color palette (dark monochromatic + emerald accent)
- Typography (Inter + JetBrains Mono)
- Component library (GlassCard, Button, Input, Shimmer, EncryptedAmount)
- Animation system (Framer Motion page transitions, staggered lists, micro-interactions)
- Background treatment (radial gradients + SVG noise + flashlight effect)
- Responsive strategy (separate mobile/desktop component trees)
- Patterns adopted from NullPay reference project

### Key Frontend Architecture Patterns

#### 1. Hook-Orchestrated Flat Components (from NullPay)
Pages are thin shells. Hooks hold ALL logic. Components are presentational only.
```typescript
// Page
function SendPage() {
  const { amount, setAmount, recipient, send, isPending, step } = useSendPayment();
  return <SendForm amount={amount} onAmountChange={setAmount} ... />;
}
```

#### 2. Payment Step State Machine (from NullPay)
Every multi-step flow uses a typed string union:
```typescript
type SendStep = 'INPUT' | 'ENCRYPTING' | 'CONFIRMING' | 'SENDING' | 'SUCCESS' | 'ERROR';
type RequestStep = 'CREATE' | 'SHARING' | 'WAITING' | 'FULFILLED';
type EscrowStep = 'DEPOSIT' | 'LOCKED' | 'DELIVERED' | 'APPROVED' | 'RELEASED';
```

#### 3. Encryption Progress Feedback
FHE encryption takes 2-5 seconds. MUST show progress:
```typescript
const { encryptInputsAsync, stepsState } = useCofheEncrypt();
// stepsState shows: initTfhe → fetchKeys → pack → prove → verify → done
// Map each to a visual progress bar
```

#### 4. Decrypted Data Security
- NEVER persist decrypted amounts to localStorage or any storage
- Keep in React state (memory only)
- Auto-clear after timeout (10s reveal window)
- Use `useRef` for sensitive values, not `useState` (avoids React DevTools exposure)

---

## REFERENCE PROJECT

**NullPay Frontend:** `C:\Users\prate\VeilSub\aleo-reference-projects\NullPay\frontend`

Key files to reference for design patterns:
- `src/shared/components/ui/GlassCard.tsx` — Glass card component
- `src/shared/components/ui/Button.tsx` — Motion button variants
- `src/shared/components/ui/Shimmer.tsx` — Loading skeleton
- `src/shared/utils/animations.ts` — Framer Motion variants
- `src/desktop/components/Navbar.tsx` — layoutId pill navigation
- `src/desktop/pages/Home/components/FlashlightEffect.tsx` — Mouse-tracking gradient
- `src/shared/hooks/useCreateInvoice.ts` — Hook-orchestrated payment logic
- `src/shared/hooks/Payments/useSharedPayment.ts` — Payment step state machine
- `tailwind.config.js` — Glass morphism design tokens
- `src/index.css` — Background layers, noise texture, CTA button styles
