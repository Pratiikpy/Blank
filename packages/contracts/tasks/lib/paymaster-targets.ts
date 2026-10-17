// Contracts a BlankAccount calls from the app, by deployments-JSON key.
// BlankPaymaster sponsors only execute / executeBatch to approved targets,
// so this list and the app have to agree. setup-aa and
// wire-paymaster-targets both read it.
//
// Never listed: the account itself. Account settings changes (upgrade,
// enableValidator, setRecoveryModule) target the sender, which no global
// allowlist can name; they pay their own gas.
export const PAYMASTER_TARGETS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "FHERC20Vault_USDC", label: "FHERC20Vault USDC (shield/unshield)" },
  { key: "FHERC20Vault_USDT", label: "FHERC20Vault USDT" },
  { key: "TestUSDC", label: "TestUSDC (faucet/approve, scheduled sends)" },
  { key: "TestUSDT", label: "TestUSDT" },
  { key: "PaymentHub", label: "PaymentHub" },
  { key: "BusinessHub", label: "BusinessHub" },
  { key: "EncryptedEscrow", label: "EncryptedEscrow" },
  { key: "InvoiceApprovalResolver", label: "InvoiceApprovalResolver" },
  { key: "GroupManager", label: "GroupManager" },
  { key: "CreatorHub", label: "CreatorHub" },
  // createOffer/fillOffer are retired, cancelOffer still lets makers exit.
  { key: "P2PExchange", label: "P2PExchange (cancel only)" },
  { key: "P2POfframp", label: "P2POfframp" },
  { key: "GiftMoney", label: "GiftMoney" },
  { key: "StealthPayments", label: "StealthPayments" },
  { key: "ERC6538Registry", label: "ERC-6538 registry (stealth meta-address)" },
  { key: "ERC5564Announcer", label: "ERC-5564 announcer" },
  { key: "InheritanceManager", label: "InheritanceManager" },
  { key: "PrivacyRouter", label: "PrivacyRouter" },
  { key: "PaymentReceipts", label: "PaymentReceipts" },
  { key: "EncryptedFlags", label: "EncryptedFlags" },
  { key: "ClaimLinks", label: "ClaimLinks" },
  { key: "Storefront", label: "Storefront" },
  { key: "EncryptedCrowdfund", label: "EncryptedCrowdfund" },
  { key: "BurnerRegistry", label: "BurnerRegistry" },
  { key: "BlankHandles", label: "BlankHandles" },
  { key: "GuardianModule", label: "GuardianModule (guardians, recovery votes)" },
  { key: "SessionKeyValidator", label: "SessionKeyValidator (setScope/revokeScope)" },
];

// Retired on-chain: every write reverts, so sponsoring them only burns the
// deposit. wire-paymaster-targets un-approves them. Old addresses kept under
// *_v0 after a fresh deploy are retired too.
export const RETIRED_TARGETS: ReadonlyArray<string> = [
  "ProofOfBalance",
  "SessionKeyValidator_v0",
  "InvoiceApprovalResolver_v0",
  "BurnerRegistry_v0",
];
