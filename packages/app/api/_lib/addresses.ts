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

export interface ServerContractMap {
  PaymentHub: string;
  GiftMoney: string;
  FHERC20Vault_USDC: string;
}

type ContractKey = keyof ServerContractMap;

function readAddr(envKey: string, fallback: string): string {
  const v = process.env[envKey];
  if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return v;
  return fallback;
}

const DEFAULTS: Record<number, ServerContractMap> = {
  [ETH_SEPOLIA_ID]: {
    PaymentHub: "0xB628719994C21A5CcAb190019b42750f092Fb5eB",
    GiftMoney: "0x845A25c4d4d0Acfc9AfDd3016A1D55b986Bad4F9",
    FHERC20Vault_USDC: "0x3a587f224CC3e1745565cfca8500e5934485AB51",
  },
  [BASE_SEPOLIA_ID]: {
    PaymentHub: "0xF420102Dea1acf437bfc49ded5F4E2f5ed32e831",
    GiftMoney: "0x37374487A6575780A6DE3C83440441C7aB03cDDf",
    FHERC20Vault_USDC: "0x789f0bC466E172eD737493e9796a6d0a3aB0ff23",
  },
};

const ENV_PREFIX: Record<number, string> = {
  [ETH_SEPOLIA_ID]: "BLANK_ETH_SEPOLIA_",
  [BASE_SEPOLIA_ID]: "BLANK_BASE_SEPOLIA_",
};

function buildMap(chainId: number): ServerContractMap {
  const defaults = DEFAULTS[chainId];
  const prefix = ENV_PREFIX[chainId];
  return {
    PaymentHub: readAddr(`${prefix}PAYMENT_HUB`, defaults.PaymentHub),
    GiftMoney: readAddr(`${prefix}GIFT_MONEY`, defaults.GiftMoney),
    FHERC20Vault_USDC: readAddr(`${prefix}FHERC20_VAULT_USDC`, defaults.FHERC20Vault_USDC),
  };
}

export const CONTRACTS_BY_CHAIN: Record<number, ServerContractMap> = {
  [ETH_SEPOLIA_ID]: buildMap(ETH_SEPOLIA_ID),
  [BASE_SEPOLIA_ID]: buildMap(BASE_SEPOLIA_ID),
};

export function getContracts(chainId: number): ServerContractMap | null {
  return CONTRACTS_BY_CHAIN[chainId] ?? null;
}

export const RPC_URLS: Record<number, string> = {
  [ETH_SEPOLIA_ID]: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com",
  [BASE_SEPOLIA_ID]: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
};

export type { ContractKey };
