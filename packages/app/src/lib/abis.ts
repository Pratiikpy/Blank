// Contract ABIs — extracted from compiled artifacts
// These will be replaced with actual ABIs after deployment

export const TestUSDCAbi = [
  { type: "function", name: "mint", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "faucet", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ name: "", type: "uint8" }], stateMutability: "pure" },
  { type: "function", name: "symbol", inputs: [], outputs: [{ name: "", type: "string" }], stateMutability: "view" },
] as const;

// ─── Encrypted input tuple component (shared across functions) ───────
// The internalType annotations are critical for @cofhe/abi:
//   - Input tuples with internalType "struct InEuint64" tell extractEncryptableValues
//     to auto-encrypt those args via the SDK (ZK proof + ciphertext)
//   - Output uint256 with internalType "euint64" tells transformEncryptedReturnTypes
//     to convert the raw ctHash into { ctHash, utype: FheTypes.Uint64 } for decryption
const InEuint64Components = [
  { name: "ctHash", type: "uint256", internalType: "uint256" },
  { name: "securityZone", type: "uint8", internalType: "uint8" },
  { name: "utype", type: "uint8", internalType: "uint8" },
  { name: "signature", type: "bytes", internalType: "bytes" },
] as const;

export const FHERC20VaultAbi = [
  { type: "function", name: "shield", inputs: [{ name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "requestUnshield", inputs: [{ name: "encAmount", type: "tuple", internalType: "struct InEuint64", components: InEuint64Components }], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "claimUnshield", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "transfer", inputs: [{ name: "to", type: "address" }, { name: "encAmount", type: "tuple", internalType: "struct InEuint64", components: InEuint64Components }], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "transferFrom", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "encAmount", type: "tuple", internalType: "struct InEuint64", components: InEuint64Components }], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "encAmount", type: "tuple", internalType: "struct InEuint64", components: InEuint64Components }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "approvePlaintext", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint64" }], outputs: [], stateMutability: "nonpayable" },
  // balanceOf returns an encrypted euint64 handle on-chain.
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256", internalType: "euint64" }], stateMutability: "view" },
  { type: "function", name: "totalDeposited", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "isInitialized", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "allowance", inputs: [{ name: "owner_", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256", internalType: "euint64" }], stateMutability: "view" },
  { type: "event", name: "Shielded", inputs: [{ name: "user", type: "address", indexed: true }, { name: "token", type: "address", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "EncryptedTransfer", inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "EncryptedApproval", inputs: [{ name: "owner", type: "address", indexed: true }, { name: "spender", type: "address", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
] as const;

export const PaymentHubAbi = [
  { type: "function", name: "sendPayment", inputs: [{ name: "to", type: "address" }, { name: "vault", type: "address" }, { name: "encAmount", type: "tuple", internalType: "struct InEuint64", components: InEuint64Components }, { name: "note", type: "string" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "createRequest", inputs: [{ name: "from", type: "address" }, { name: "vault", type: "address" }, { name: "encAmount", type: "tuple", internalType: "struct InEuint64", components: InEuint64Components }, { name: "note", type: "string" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "fulfillRequest", inputs: [{ name: "requestId", type: "uint256" }, { name: "encAmount", type: "tuple", internalType: "struct InEuint64", components: InEuint64Components }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "cancelRequest", inputs: [{ name: "requestId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "getIncomingRequests", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "", type: "uint256[]" }], stateMutability: "view" },
  { type: "function", name: "getOutgoingRequests", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "", type: "uint256[]" }], stateMutability: "view" },
  { type: "function", name: "getPendingIncomingCount", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "getRequest", inputs: [{ name: "requestId", type: "uint256" }], outputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "vault", type: "address" }, { name: "amount", type: "uint256", internalType: "euint64" }, { name: "note", type: "string" }, { name: "status", type: "uint8" }, { name: "createdAt", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "batchSend", inputs: [{ name: "recipients", type: "address[]" }, { name: "vault", type: "address" }, { name: "amounts", type: "tuple[]", internalType: "struct InEuint64[]", components: InEuint64Components }, { name: "notes", type: "string[]" }], outputs: [], stateMutability: "nonpayable" },
  { type: "event", name: "PaymentSent", inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "vault", type: "address", indexed: false }, { name: "note", type: "string", indexed: false }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "RequestCreated", inputs: [{ name: "requestId", type: "uint256", indexed: true }, { name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "vault", type: "address", indexed: false }, { name: "note", type: "string", indexed: false }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "RequestFulfilled", inputs: [{ name: "requestId", type: "uint256", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "RequestCancelled", inputs: [{ name: "requestId", type: "uint256", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "BatchPaymentSent", inputs: [{ name: "from", type: "address", indexed: true }, { name: "vault", type: "address", indexed: false }, { name: "recipientCount", type: "uint256", indexed: false }, { name: "timestamp", type: "uint256", indexed: false }] },
] as const;

export const EventHubAbi = [
  { type: "event", name: "Activity", inputs: [{ name: "user1", type: "address", indexed: true }, { name: "user2", type: "address", indexed: true }, { name: "activityType", type: "string", indexed: false }, { name: "sourceContract", type: "address", indexed: false }, { name: "note", type: "string", indexed: false }, { name: "refId", type: "uint256", indexed: false }, { name: "timestamp", type: "uint256", indexed: false }] },
] as const;

export const TokenRegistryAbi = [
  { type: "function", name: "getActiveTokens", inputs: [], outputs: [{ name: "", type: "tuple[]", components: [{ name: "vault", type: "address" }, { name: "underlying", type: "address" }, { name: "name", type: "string" }, { name: "symbol", type: "string" }, { name: "decimals", type: "uint8" }, { name: "active", type: "bool" }] }], stateMutability: "view" },
] as const;

// ─── Encrypted input tuple type (reused across ABIs) ────────────────
// MUST match the actual InEuint64 struct from @fhenixprotocol/cofhe-contracts/ICofhe.sol:
// struct InEuint64 { uint256 ctHash; uint8 securityZone; uint8 utype; bytes signature; }
// The internalType "struct InEuint64" enables @cofhe/abi's extractEncryptableValues
// to auto-identify and encrypt these parameters.
const InEuint64Tuple = { name: "encAmount", type: "tuple", internalType: "struct InEuint64" as const, components: InEuint64Components } as const;

export const GroupManagerAbi = [
  { type: "function", name: "createGroup", inputs: [{ name: "name", type: "string" }, { name: "members", type: "address[]" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "addExpense", inputs: [{ name: "groupId", type: "uint256" }, { name: "splitWith", type: "address[]" }, { name: "shares", type: "tuple[]", internalType: "struct InEuint64[]", components: InEuint64Components }, { name: "totalPaid", type: "tuple", internalType: "struct InEuint64", components: InEuint64Components }, { name: "description", type: "string" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "settleDebt", inputs: [{ name: "groupId", type: "uint256" }, { name: "with_", type: "address" }, { name: "vault", type: "address" }, InEuint64Tuple], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "getMyDebt", inputs: [{ name: "groupId", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "getGroup", inputs: [{ name: "groupId", type: "uint256" }], outputs: [{ name: "name", type: "string" }, { name: "members", type: "address[]" }, { name: "expenseCount", type: "uint256" }, { name: "active", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "getUserGroups", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "", type: "uint256[]" }], stateMutability: "view" },
  { type: "event", name: "GroupCreated", inputs: [{ name: "groupId", type: "uint256", indexed: true }, { name: "name", type: "string", indexed: false }, { name: "members", type: "address[]", indexed: false }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "function", name: "voteOnExpense", inputs: [{ name: "groupId", type: "uint256" }, { name: "expenseId", type: "uint256" }, { name: "encVotes", type: "tuple", internalType: "struct InEuint64", components: InEuint64Components }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "getExpenseVotes", inputs: [{ name: "groupId", type: "uint256" }, { name: "expenseId", type: "uint256" }], outputs: [{ name: "", type: "uint256", internalType: "euint64" }], stateMutability: "view" },
  { type: "function", name: "addMember", inputs: [{ name: "groupId", type: "uint256" }, { name: "member", type: "address" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "addAdmin", inputs: [{ name: "groupId", type: "uint256" }, { name: "admin", type: "address" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "getExpense", inputs: [{ name: "groupId", type: "uint256" }, { name: "expenseId", type: "uint256" }], outputs: [{ name: "payer", type: "address" }, { name: "description", type: "string" }, { name: "timestamp", type: "uint256" }], stateMutability: "view" },
  { type: "event", name: "ExpenseAdded", inputs: [{ name: "groupId", type: "uint256", indexed: true }, { name: "expenseId", type: "uint256", indexed: false }, { name: "payer", type: "address", indexed: true }, { name: "description", type: "string", indexed: false }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "MemberAdded", inputs: [{ name: "groupId", type: "uint256", indexed: true }, { name: "member", type: "address", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "AdminAdded", inputs: [{ name: "groupId", type: "uint256", indexed: true }, { name: "admin", type: "address", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "DebtSettled", inputs: [{ name: "groupId", type: "uint256", indexed: true }, { name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
] as const;

export const CreatorHubAbi = [
  { type: "function", name: "setProfile", inputs: [{ name: "name", type: "string" }, { name: "bio", type: "string" }, { name: "tier1", type: "uint64" }, { name: "tier2", type: "uint64" }, { name: "tier3", type: "uint64" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "support", inputs: [{ name: "creator", type: "address" }, { name: "vault", type: "address" }, InEuint64Tuple, { name: "message", type: "string" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "checkMyTier", inputs: [{ name: "creator", type: "address" }], outputs: [{ name: "bronze", type: "uint256" }, { name: "silver", type: "uint256" }, { name: "gold", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "getProfile", inputs: [{ name: "creator", type: "address" }], outputs: [{ name: "name", type: "string" }, { name: "bio", type: "string" }, { name: "tier1", type: "uint64" }, { name: "tier2", type: "uint64" }, { name: "tier3", type: "uint64" }, { name: "supporterCount", type: "uint256" }, { name: "active", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "getMyContribution", inputs: [{ name: "creator", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "event", name: "Supported", inputs: [{ name: "supporter", type: "address", indexed: true }, { name: "creator", type: "address", indexed: true }, { name: "message", type: "string", indexed: false }, { name: "timestamp", type: "uint256", indexed: false }] },
] as const;

export const BusinessHubAbi = [
  { type: "function", name: "createInvoice", inputs: [{ name: "client", type: "address" }, { name: "vault", type: "address" }, InEuint64Tuple, { name: "description", type: "string" }, { name: "dueDate", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "payInvoice", inputs: [{ name: "invoiceId", type: "uint256" }, InEuint64Tuple], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "cancelInvoice", inputs: [{ name: "invoiceId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "runPayroll", inputs: [{ name: "employees", type: "address[]" }, { name: "vault", type: "address" }, { name: "salaries", type: "tuple[]", internalType: "struct InEuint64[]", components: InEuint64Components }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "createEscrow", inputs: [{ name: "beneficiary", type: "address" }, { name: "vault", type: "address" }, { name: "plaintextAmount", type: "uint256" }, { name: "description", type: "string" }, { name: "arbiter", type: "address" }, { name: "deadline", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "markDelivered", inputs: [{ name: "escrowId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "approveRelease", inputs: [{ name: "escrowId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "disputeEscrow", inputs: [{ name: "escrowId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "getVendorInvoices", inputs: [{ name: "vendor", type: "address" }], outputs: [{ name: "", type: "uint256[]" }], stateMutability: "view" },
  { type: "function", name: "getClientInvoices", inputs: [{ name: "client", type: "address" }], outputs: [{ name: "", type: "uint256[]" }], stateMutability: "view" },
  { type: "function", name: "getUserEscrows", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "", type: "uint256[]" }], stateMutability: "view" },
  { type: "function", name: "payInvoiceFinalize", inputs: [{ name: "invoiceId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "getInvoice", inputs: [{ name: "id", type: "uint256" }], outputs: [{ name: "vendor", type: "address" }, { name: "client", type: "address" }, { name: "vault", type: "address" }, { name: "amount", type: "uint256", internalType: "euint64" }, { name: "description", type: "string" }, { name: "dueDate", type: "uint256" }, { name: "status", type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "getEscrow", inputs: [{ name: "id", type: "uint256" }], outputs: [{ name: "depositor", type: "address" }, { name: "beneficiary", type: "address" }, { name: "arbiter", type: "address" }, { name: "vault", type: "address" }, { name: "amount", type: "uint256", internalType: "euint64" }, { name: "description", type: "string" }, { name: "deadline", type: "uint256" }, { name: "status", type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "arbiterDecide", inputs: [{ name: "escrowId", type: "uint256" }, { name: "releaseToBeneficiary", type: "bool" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "claimExpiredEscrow", inputs: [{ name: "escrowId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "event", name: "InvoiceCreated", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "vendor", type: "address", indexed: true }, { name: "client", type: "address", indexed: true }, { name: "description", type: "string", indexed: false }, { name: "dueDate", type: "uint256", indexed: false }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "InvoicePaymentInitiated", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "InvoicePaid", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "InvoiceCancelled", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "InvoiceDisputed", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "PayrollExecuted", inputs: [{ name: "employer", type: "address", indexed: true }, { name: "count", type: "uint256", indexed: false }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "EscrowCreated", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "depositor", type: "address", indexed: true }, { name: "beneficiary", type: "address", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "EscrowDelivered", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "EscrowApproved", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "EscrowReleased", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "EscrowDisputed", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "disputer", type: "address", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "EscrowExpiryClaimed", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "EscrowArbiterDecided", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "releasedToBeneficiary", type: "bool", indexed: false }, { name: "timestamp", type: "uint256", indexed: false }] },
] as const;

export const P2PExchangeAbi = [
  { type: "function", name: "createOffer", inputs: [{ name: "tokenGive", type: "address" }, { name: "tokenWant", type: "address" }, { name: "amountGive", type: "uint256" }, { name: "amountWant", type: "uint256" }, { name: "expiry", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "fillOffer", inputs: [{ name: "offerId", type: "uint256" }, { name: "encTakerPayment", type: "tuple", internalType: "struct InEuint64", components: InEuint64Components }, { name: "encMakerPayment", type: "tuple", internalType: "struct InEuint64", components: InEuint64Components }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "cancelOffer", inputs: [{ name: "offerId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "getActiveOffers", inputs: [{ name: "offset", type: "uint256" }, { name: "limit", type: "uint256" }], outputs: [{ name: "", type: "tuple[]", components: [{ name: "maker", type: "address" }, { name: "tokenGive", type: "address" }, { name: "tokenWant", type: "address" }, { name: "amountGive", type: "uint256" }, { name: "amountWant", type: "uint256" }, { name: "expiry", type: "uint256" }, { name: "active", type: "bool" }, { name: "filled", type: "bool" }] }], stateMutability: "view" },
  { type: "function", name: "getTradeValidation", inputs: [{ name: "offerId", type: "uint256" }], outputs: [{ name: "isValid", type: "bool" }, { name: "isReady", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "getUserOffers", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "", type: "uint256[]" }], stateMutability: "view" },
  { type: "event", name: "OfferCreated", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "maker", type: "address", indexed: true }, { name: "tokenGive", type: "address", indexed: false }, { name: "tokenWant", type: "address", indexed: false }, { name: "amountGive", type: "uint256", indexed: false }, { name: "amountWant", type: "uint256", indexed: false }, { name: "expiry", type: "uint256", indexed: false }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "OfferFilled", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "taker", type: "address", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "OfferCancelled", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
] as const;

export const GiftMoneyAbi = [
  { type: "function", name: "createEnvelope", inputs: [{ name: "vault", type: "address" }, { name: "recipients", type: "address[]" }, { name: "shares", type: "tuple[]", components: [{ name: "ctHash", type: "uint256" }, { name: "securityZone", type: "uint8" }, { name: "utype", type: "uint8" }, { name: "signature", type: "bytes" }] }, { name: "note", type: "string" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "claimGift", inputs: [{ name: "envelopeId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "getMyGift", inputs: [{ name: "envelopeId", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "getEnvelope", inputs: [{ name: "envelopeId", type: "uint256" }], outputs: [{ name: "sender", type: "address" }, { name: "vault", type: "address" }, { name: "recipientCount", type: "uint256" }, { name: "claimedCount", type: "uint256" }, { name: "note", type: "string" }, { name: "timestamp", type: "uint256" }, { name: "active", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "getRecipients", inputs: [{ name: "envelopeId", type: "uint256" }], outputs: [{ name: "", type: "address[]" }], stateMutability: "view" },
  { type: "function", name: "getReceivedEnvelopes", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "", type: "uint256[]" }], stateMutability: "view" },
  { type: "function", name: "getSentEnvelopes", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "", type: "uint256[]" }], stateMutability: "view" },
  { type: "function", name: "opened", inputs: [{ name: "envelopeId", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "isRecipient", inputs: [{ name: "envelopeId", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "isFullyOpened", inputs: [{ name: "envelopeId", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { type: "event", name: "EnvelopeCreated", inputs: [{ name: "envelopeId", type: "uint256", indexed: true }, { name: "sender", type: "address", indexed: true }, { name: "vault", type: "address", indexed: false }, { name: "recipientCount", type: "uint256", indexed: false }, { name: "note", type: "string", indexed: false }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "GiftOpened", inputs: [{ name: "envelopeId", type: "uint256", indexed: true }, { name: "recipient", type: "address", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
] as const;

export const InheritanceManagerAbi = [
  { type: "function", name: "setHeir", inputs: [{ name: "heir", type: "address" }, { name: "inactivityPeriod", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "removeHeir", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "heartbeat", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "startClaim", inputs: [{ name: "owner_", type: "address" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "finalizeClaim", inputs: [{ name: "owner_", type: "address" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "getPlan", inputs: [{ name: "owner_", type: "address" }], outputs: [{ name: "heir", type: "address" }, { name: "inactivityPeriod", type: "uint256" }, { name: "lastHeartbeat", type: "uint256" }, { name: "claimStartedAt", type: "uint256" }, { name: "active", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "isClaimable", inputs: [{ name: "owner_", type: "address" }], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
] as const;

// ─── Encrypted input tuple for InEaddress (same struct layout as InEuint64) ──
const InEaddressComponents = [
  { name: "ctHash", type: "uint256", internalType: "uint256" },
  { name: "securityZone", type: "uint8", internalType: "uint8" },
  { name: "utype", type: "uint8", internalType: "uint8" },
  { name: "signature", type: "bytes", internalType: "bytes" },
] as const;

// ─── Encrypted input tuple for InEuint8 (same struct layout as InEuint64) ────
const InEuint8Components = [
  { name: "ctHash", type: "uint256", internalType: "uint256" },
  { name: "securityZone", type: "uint8", internalType: "uint8" },
  { name: "utype", type: "uint8", internalType: "uint8" },
  { name: "signature", type: "bytes", internalType: "bytes" },
] as const;

// ─── PrivacyRouter — Encrypted token swap router ─────────────────────────────
// Source: contracts/PrivacyRouter.sol
// Flow: initiateSwap (encrypted amount) → async decrypt → executeSwap (DEX swap)
export const PrivacyRouterAbi = [
  // Swap lifecycle
  { type: "function", name: "initiateSwap", inputs: [{ name: "vaultIn", type: "address" }, { name: "vaultOut", type: "address" }, { name: "encAmount", type: "tuple", internalType: "struct InEuint64", components: InEuint64Components }, { name: "minAmountOut", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "executeSwap", inputs: [{ name: "swapId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "cancelSwap", inputs: [{ name: "swapId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "claimExpiredSwap", inputs: [{ name: "swapId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  // View functions
  { type: "function", name: "getSwap", inputs: [{ name: "swapId", type: "uint256" }], outputs: [{ name: "user", type: "address" }, { name: "vaultIn", type: "address" }, { name: "vaultOut", type: "address" }, { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "plaintextAmountIn", type: "uint256" }, { name: "minAmountOut", type: "uint256" }, { name: "timestamp", type: "uint256" }, { name: "status", type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "getUserSwaps", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "", type: "uint256[]" }], stateMutability: "view" },
  { type: "function", name: "isDecryptionReady", inputs: [{ name: "swapId", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "isExpired", inputs: [{ name: "swapId", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "reserves", inputs: [{ name: "token", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "nextSwapId", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "SWAP_EXPIRY", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  // Admin
  { type: "function", name: "fundReserves", inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  // Events
  { type: "event", name: "SwapInitiated", inputs: [{ name: "swapId", type: "uint256", indexed: true }, { name: "user", type: "address", indexed: true }, { name: "vaultIn", type: "address", indexed: false }, { name: "vaultOut", type: "address", indexed: false }, { name: "minAmountOut", type: "uint256", indexed: false }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "SwapExecuted", inputs: [{ name: "swapId", type: "uint256", indexed: true }, { name: "user", type: "address", indexed: true }, { name: "amountOut", type: "uint256", indexed: false }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "SwapCancelled", inputs: [{ name: "swapId", type: "uint256", indexed: true }, { name: "user", type: "address", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "SwapExpired", inputs: [{ name: "swapId", type: "uint256", indexed: true }, { name: "user", type: "address", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
] as const;

// ─── StealthPayments — Privacy-preserving stealth payment system ──────────────
// Source: contracts/StealthPayments.sol
// Flow: sendStealth (plaintext ERC20 deposit + encrypted recipient) → claimStealth (verify claim code + FHE identity check) → finalizeClaim (after async decrypt)
export const StealthPaymentsAbi = [
  // Send stealth payment
  { type: "function", name: "sendStealth", inputs: [{ name: "plaintextAmount", type: "uint256" }, { name: "encRecipient", type: "tuple", internalType: "struct InEaddress", components: InEaddressComponents }, { name: "claimCodeHash", type: "bytes32" }, { name: "vault", type: "address" }, { name: "note", type: "string" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable" },
  // Claim lifecycle
  { type: "function", name: "claimStealth", inputs: [{ name: "transferId", type: "uint256" }, { name: "claimCode", type: "bytes32" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "finalizeClaim", inputs: [{ name: "transferId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "refund", inputs: [{ name: "transferId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  // View functions
  { type: "function", name: "getTransferInfo", inputs: [{ name: "transferId", type: "uint256" }], outputs: [{ name: "sender", type: "address" }, { name: "vault", type: "address" }, { name: "underlyingToken", type: "address" }, { name: "plaintextAmount", type: "uint256" }, { name: "claimCodeHash", type: "bytes32" }, { name: "note", type: "string" }, { name: "timestamp", type: "uint256" }, { name: "claimed", type: "bool" }, { name: "finalized", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "getTransferEncryptedAmount", inputs: [{ name: "transferId", type: "uint256" }], outputs: [{ name: "", type: "uint256", internalType: "euint64" }], stateMutability: "view" },
  { type: "function", name: "getTransferEncryptedRecipient", inputs: [{ name: "transferId", type: "uint256" }], outputs: [{ name: "", type: "uint256", internalType: "eaddress" }], stateMutability: "view" },
  { type: "function", name: "getSenderTransfers", inputs: [{ name: "sender", type: "address" }], outputs: [{ name: "", type: "uint256[]" }], stateMutability: "view" },
  { type: "function", name: "getMyPendingClaims", inputs: [{ name: "claimCodeHashes", type: "bytes32[]" }], outputs: [{ name: "transferIds", type: "uint256[]" }, { name: "found", type: "bool[]" }], stateMutability: "view" },
  { type: "function", name: "getClaimStatus", inputs: [{ name: "transferId", type: "uint256" }], outputs: [{ name: "claimer", type: "address" }, { name: "isPending", type: "bool" }, { name: "isFinalized", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "totalTransfers", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "nextTransferId", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  // Events
  { type: "event", name: "StealthSent", inputs: [{ name: "transferId", type: "uint256", indexed: true }, { name: "sender", type: "address", indexed: true }, { name: "claimCodeHash", type: "bytes32", indexed: false }, { name: "vault", type: "address", indexed: false }, { name: "note", type: "string", indexed: false }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "StealthClaimStarted", inputs: [{ name: "transferId", type: "uint256", indexed: true }, { name: "claimer", type: "address", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "StealthFinalized", inputs: [{ name: "transferId", type: "uint256", indexed: true }, { name: "claimer", type: "address", indexed: true }, { name: "plaintextAmount", type: "uint256", indexed: false }, { name: "timestamp", type: "uint256", indexed: false }] },
] as const;

// ─── EncryptedFlags — Encrypted compliance flags, fee engine, access control ──
// Source: contracts/EncryptedFlags.sol
// Uses: ebool for encrypted booleans, euint8 for bitmasks, euint64 for fee calculations
export const EncryptedFlagsAbi = [
  // Encrypted boolean flag checks (returns ebool handle)
  { type: "function", name: "canSend", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "", type: "uint256", internalType: "ebool" }], stateMutability: "nonpayable" },
  { type: "function", name: "canReceive", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "", type: "uint256", internalType: "ebool" }], stateMutability: "nonpayable" },
  // Fee calculation (returns encrypted fee + netAmount handles)
  { type: "function", name: "calculateFee", inputs: [{ name: "encAmount", type: "tuple", internalType: "struct InEuint64", components: InEuint64Components }], outputs: [{ name: "fee", type: "uint256", internalType: "euint64" }, { name: "netAmount", type: "uint256", internalType: "euint64" }], stateMutability: "nonpayable" },
  { type: "function", name: "calculateMerchantFee", inputs: [{ name: "encAmount", type: "tuple", internalType: "struct InEuint64", components: InEuint64Components }, { name: "merchant", type: "address" }], outputs: [{ name: "fee", type: "uint256", internalType: "euint64" }, { name: "netAmount", type: "uint256", internalType: "euint64" }], stateMutability: "nonpayable" },
  // Audit scope management
  { type: "function", name: "setAuditScope", inputs: [{ name: "auditor", type: "address" }, { name: "encScope", type: "tuple", internalType: "struct InEuint8", components: InEuint8Components }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "checkAuditScope", inputs: [{ name: "user", type: "address" }, { name: "auditor", type: "address" }, { name: "encBitMask", type: "tuple", internalType: "struct InEuint8", components: InEuint8Components }], outputs: [{ name: "", type: "uint256", internalType: "ebool" }], stateMutability: "nonpayable" },
  // View functions (return encrypted handles — caller must unseal)
  { type: "function", name: "getMyVerifiedStatus", inputs: [], outputs: [{ name: "", type: "uint256", internalType: "ebool" }], stateMutability: "view" },
  { type: "function", name: "getMyActiveStatus", inputs: [], outputs: [{ name: "", type: "uint256", internalType: "ebool" }], stateMutability: "view" },
  { type: "function", name: "getMyKYCStatus", inputs: [], outputs: [{ name: "", type: "uint256", internalType: "ebool" }], stateMutability: "view" },
  { type: "function", name: "getMyMerchantStatus", inputs: [], outputs: [{ name: "", type: "uint256", internalType: "ebool" }], stateMutability: "view" },
  { type: "function", name: "getAuditScope", inputs: [{ name: "auditor", type: "address" }], outputs: [{ name: "", type: "uint256", internalType: "euint8" }], stateMutability: "view" },
  // Events
  { type: "event", name: "FlagSet", inputs: [{ name: "user", type: "address", indexed: true }, { name: "flagType", type: "string", indexed: false }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "AuditScopeSet", inputs: [{ name: "user", type: "address", indexed: true }, { name: "auditor", type: "address", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
  { type: "event", name: "FeeCalculated", inputs: [{ name: "user", type: "address", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
] as const;

// ─── PaymentReceipts — Cryptographic encrypted receipts for payments ──────────
// Source: contracts/PaymentReceipts.sol
// Uses: FHE.randomEuint64 for unique IDs, encrypted running totals, eq/min/max comparisons
export const PaymentReceiptsAbi = [
  // Issue receipt
  { type: "function", name: "issueReceipt", inputs: [{ name: "payer", type: "address" }, { name: "payee", type: "address" }, { name: "encAmount", type: "tuple", internalType: "struct InEuint64", components: InEuint64Components }, { name: "token", type: "address" }], outputs: [{ name: "", type: "bytes32" }], stateMutability: "nonpayable" },
  // Verify receipt (public)
  { type: "function", name: "verifyReceipt", inputs: [{ name: "receiptHash", type: "bytes32" }], outputs: [{ name: "exists", type: "bool" }, { name: "payer", type: "address" }, { name: "payee", type: "address" }, { name: "token", type: "address" }, { name: "timestamp", type: "uint256" }], stateMutability: "view" },
  // Encrypted data accessors (return handles — caller must unseal)
  { type: "function", name: "getReceiptAmount", inputs: [{ name: "receiptHash", type: "bytes32" }], outputs: [{ name: "", type: "uint256", internalType: "euint64" }], stateMutability: "view" },
  { type: "function", name: "getReceiptPaymentId", inputs: [{ name: "receiptHash", type: "bytes32" }], outputs: [{ name: "", type: "uint256", internalType: "euint64" }], stateMutability: "view" },
  // User encrypted stats (return handles — caller must unseal)
  { type: "function", name: "getMyTotalSent", inputs: [], outputs: [{ name: "", type: "uint256", internalType: "euint64" }], stateMutability: "view" },
  { type: "function", name: "getMyTotalReceived", inputs: [], outputs: [{ name: "", type: "uint256", internalType: "euint64" }], stateMutability: "view" },
  { type: "function", name: "getMyTransactionCount", inputs: [], outputs: [{ name: "", type: "uint256", internalType: "euint64" }], stateMutability: "view" },
  // Receipt list
  { type: "function", name: "getUserReceipts", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "", type: "bytes32[]" }], stateMutability: "view" },
  { type: "function", name: "receiptCount", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  // Encrypted comparisons (return handles — caller must unseal)
  { type: "function", name: "compareReceiptAmounts", inputs: [{ name: "hash1", type: "bytes32" }, { name: "hash2", type: "bytes32" }], outputs: [{ name: "", type: "uint256", internalType: "ebool" }], stateMutability: "nonpayable" },
  { type: "function", name: "maxReceiptAmount", inputs: [{ name: "hash1", type: "bytes32" }, { name: "hash2", type: "bytes32" }], outputs: [{ name: "", type: "uint256", internalType: "euint64" }], stateMutability: "nonpayable" },
  { type: "function", name: "minReceiptAmount", inputs: [{ name: "hash1", type: "bytes32" }, { name: "hash2", type: "bytes32" }], outputs: [{ name: "", type: "uint256", internalType: "euint64" }], stateMutability: "nonpayable" },
  // Events
  { type: "event", name: "ReceiptIssued", inputs: [{ name: "receiptHash", type: "bytes32", indexed: true }, { name: "payer", type: "address", indexed: true }, { name: "payee", type: "address", indexed: true }, { name: "timestamp", type: "uint256", indexed: false }] },
] as const;
