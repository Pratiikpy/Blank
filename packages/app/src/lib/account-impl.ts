import type { Address } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * The BlankAccount implementation every proxy should run on this chain: the
 * newest one the operator has deployed. Each later implementation contains
 * the earlier ones' features, so one upgrade brings an account fully current.
 * Returns address(0) when none is configured.
 */
export function latestAccountImpl(contracts: {
  BlankAccount_Impl_security_v1?: string;
  BlankAccount_Impl_gasWallet?: string;
  BlankAccount_Impl_v041?: string;
}): Address {
  for (const a of [
    contracts.BlankAccount_Impl_security_v1,
    contracts.BlankAccount_Impl_gasWallet,
    contracts.BlankAccount_Impl_v041,
  ]) {
    if (a && a.toLowerCase() !== ZERO) return a as Address;
  }
  return ZERO;
}

/** True when the security-v1 implementation is the upgrade target. */
export function isSecurityV1Target(contracts: { BlankAccount_Impl_security_v1?: string }): boolean {
  const a = contracts.BlankAccount_Impl_security_v1;
  return !!a && a.toLowerCase() !== ZERO;
}
