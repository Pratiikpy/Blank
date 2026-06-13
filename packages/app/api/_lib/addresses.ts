// Server-side contract address registry for the /api routes.
//
// Can't import packages/app/src/lib/constants.ts directly because the
// frontend constants module references `import.meta.env` which Vercel's
// serverless bundler refuses to transpile. Instead, mirror the same map
// here as a plain TS object, and allow env vars to override each address
// at deploy time so a new deploy doesn't require a code change.
//
// When updating the frontend's constants.ts after a redeploy, update the
// defaults here too. For production deployments, set the per-chain env
// vars (BLANK_<CHAIN>_<CONTRACT>) and leave the defaults as a local-dev
// fallback.

export const ETH_SEPOLIA_ID = 11155111;
export const BASE_SEPOLIA_ID = 84532;
export const ARB_SEPOLIA_ID = 421614;

export interface ServerContractMap {
  PaymentHub: string;
  GiftMoney: string;
  FHERC20Vault_USDC: string;
  /** TestUSDC — permissionless mint() so anyone can faucet 100 USDC.
   *  Used by `/api/faucet/usdc.ts` and the auto-drip on first AA deploy
   *  inside `/api/relay.ts`. Testnet only. */
  TestUSDC: string;
  /** ERC-4337 v0.8 EntryPoint — same address on every chain. Server reads
   *  `balanceOf(paymaster)` from here in `/api/cron/paymaster-monitor.ts`. */
  EntryPoint: string;
  /** BlankPaymaster — sponsors gas for AA UserOps. Cron alerts when its
   *  EntryPoint deposit drops below `PAYMASTER_ALERT_THRESHOLD_WEI`. */
  BlankPaymaster: string;
  /** PaymentReceipts — encrypted income/balance proof anchor + lifetime-
   *  received accumulator. Read by `/api/og/proof.tsx` + `/api/share/proof.ts`
   *  to render per-proof preview images and meta tags for shared links. */
  PaymentReceipts: string;
}

type ContractKey = keyof ServerContractMap;

function readAddr(envKey: string, fallback: string): string {
  const v = process.env[envKey];
  if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return v;
  return fallback;
}

const ENTRY_POINT_V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";

const DEFAULTS: Record<number, ServerContractMap> = {
  [ETH_SEPOLIA_ID]: {
    PaymentHub: "0xB628719994C21A5CcAb190019b42750f092Fb5eB",
    GiftMoney: "0x845A25c4d4d0Acfc9AfDd3016A1D55b986Bad4F9",
    FHERC20Vault_USDC: "0x3a587f224CC3e1745565cfca8500e5934485AB51",
    TestUSDC: "0x16369CD4B9533795dCdc0D67DB3E4c621ef97D68",
    EntryPoint: ENTRY_POINT_V08,
    BlankPaymaster: "0x68890C23C94e25706F064f8C1d07e04462B9Ec2E",
    PaymentReceipts: "0xE2087A39cEa3C77566DF15936c2750511f808148",
  },
  [BASE_SEPOLIA_ID]: {
    PaymentHub: "0xF420102Dea1acf437bfc49ded5F4E2f5ed32e831",
    GiftMoney: "0x37374487A6575780A6DE3C83440441C7aB03cDDf",
    FHERC20Vault_USDC: "0x789f0bC466E172eD737493e9796a6d0a3aB0ff23",
    TestUSDC: "0x6377eF23B3464019EcF35528be6Eb6d6D57d0b1a",
    EntryPoint: ENTRY_POINT_V08,
    BlankPaymaster: "0xB1CbBD59E63d7aB0BbF0406CCF1016c1Dd8e63de",
    PaymentReceipts: "0x23f0530e107cCF940093c238bbc97EbdAD6fAD7c",
  },
  [ARB_SEPOLIA_ID]: {
    PaymentHub: "0x899f22B60A856Ec6FCb7C888c43f1A9891E9d6C5",
    GiftMoney: "0x944360c5fD0eDCa2052aeC77530600c65171Dd27",
    FHERC20Vault_USDC: "0x22c543F1303Ba25A52694C89D8d09D26FBb7569E",
    TestUSDC: "0x9558E2D3157c986591F325a6e76cA2fdFDB0b7AD",
    EntryPoint: ENTRY_POINT_V08,
    BlankPaymaster: "0x9C295E5A130a5776b287dcC77b41d4b55165C8Be",
    PaymentReceipts: "0x976b79128D1d4269942EA4500e89A18D8918DDB5",
  },
};

const ENV_PREFIX: Record<number, string> = {
  [ETH_SEPOLIA_ID]: "BLANK_ETH_SEPOLIA_",
  [BASE_SEPOLIA_ID]: "BLANK_BASE_SEPOLIA_",
  [ARB_SEPOLIA_ID]: "BLANK_ARB_SEPOLIA_",
};

function buildMap(chainId: number): ServerContractMap {
  const defaults = DEFAULTS[chainId];
  const prefix = ENV_PREFIX[chainId];
  return {
    PaymentHub: readAddr(`${prefix}PAYMENT_HUB`, defaults.PaymentHub),
    GiftMoney: readAddr(`${prefix}GIFT_MONEY`, defaults.GiftMoney),
    FHERC20Vault_USDC: readAddr(`${prefix}FHERC20_VAULT_USDC`, defaults.FHERC20Vault_USDC),
    TestUSDC: readAddr(`${prefix}TEST_USDC`, defaults.TestUSDC),
    EntryPoint: readAddr(`${prefix}ENTRYPOINT`, defaults.EntryPoint),
    BlankPaymaster: readAddr(`${prefix}BLANK_PAYMASTER`, defaults.BlankPaymaster),
    PaymentReceipts: readAddr(`${prefix}PAYMENT_RECEIPTS`, defaults.PaymentReceipts),
  };
}

export const CONTRACTS_BY_CHAIN: Record<number, ServerContractMap> = {
  [ETH_SEPOLIA_ID]: buildMap(ETH_SEPOLIA_ID),
  [BASE_SEPOLIA_ID]: buildMap(BASE_SEPOLIA_ID),
  [ARB_SEPOLIA_ID]: buildMap(ARB_SEPOLIA_ID),
};

export function getContracts(chainId: number): ServerContractMap | null {
  return CONTRACTS_BY_CHAIN[chainId] ?? null;
}

export const RPC_URLS: Record<number, string> = {
  [ETH_SEPOLIA_ID]: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com",
  [BASE_SEPOLIA_ID]: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
  [ARB_SEPOLIA_ID]: process.env.ARB_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
};

export type { ContractKey };
