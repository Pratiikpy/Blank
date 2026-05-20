import type { Address } from "viem";

/**
 * Cross-instance nonce reservation for AA UserOps.
 *
 * Multiple useSmartAccount hook instances + the cofhe-bridge adapter
 * each independently read EntryPoint.getNonce. viem's 4s eth_call
 * cache used to mask this; with cache bypassed at blockTag:"pending",
 * the remaining race is concurrent submission across instances.
 *
 * Each submitter calls reserveNonce(addr, chainId, claimedNonce) right
 * after picking its nonce. Subsequent callers read the reservation via
 * getReservedNext() and take max(reserved, on-chain, local-hint). If a
 * submission fails the caller calls rollbackReservation() so the slot
 * isn't permanently skipped.
 */
const NONCE_RESERVATIONS = new Map<string, bigint>();

function nonceKey(addr: Address, chainId: number): string {
  return `${addr.toLowerCase()}:${chainId}`;
}

export function reserveNonce(
  addr: Address,
  chainId: number,
  nonce: bigint,
): void {
  const k = nonceKey(addr, chainId);
  const prev = NONCE_RESERVATIONS.get(k);
  if (prev === undefined || nonce + 1n > prev) {
    NONCE_RESERVATIONS.set(k, nonce + 1n);
  }
}

export function getReservedNext(
  addr: Address,
  chainId: number,
): bigint | undefined {
  return NONCE_RESERVATIONS.get(nonceKey(addr, chainId));
}

export function rollbackReservation(
  addr: Address,
  chainId: number,
  nonce: bigint,
): void {
  const k = nonceKey(addr, chainId);
  const prev = NONCE_RESERVATIONS.get(k);
  if (prev !== undefined && prev === nonce + 1n) {
    NONCE_RESERVATIONS.set(k, nonce);
  }
}

export function __resetNonceReservationsForTests(): void {
  NONCE_RESERVATIONS.clear();
}
