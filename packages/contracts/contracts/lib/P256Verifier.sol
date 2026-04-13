// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/**
 * @title P256 — Hybrid P-256 signature verifier
 * @notice Tries native RIP-7212 precompile (0x100) first (~3,450 gas),
 *         falls back to daimo-eth Solidity verifier (~330K gas).
 *         Future-proof: as chains adopt RIP-7212, gas drops automatically.
 *
 * @dev Ported from Z0tz cctp-bridge (z0tz-cctp-bridge/contracts/lib/P256Verifier.sol).
 *      The hybrid pattern is what lets the same BlankAccount work on both Eth
 *      Sepolia (no RIP-7212 yet) and Base Sepolia (RIP-7212 native) without
 *      branching deploy logic.
 *
 * CRITICAL: Uses staticcall for 0x100 — required for correct behavior inside
 * transaction execution (regular call returns empty on some L2s).
 */
library P256 {
    /// @dev RIP-7212 precompile address for P-256 verification.
    /// Available on Base, Arbitrum (ArbOS 30+), Ethereum (Fusaka+).
    address constant PRECOMPILE = 0x0000000000000000000000000000000000000100;

    /// @dev daimo-eth/p256-verifier: Solidity fallback (~330K gas).
    /// Deployed deterministically via CREATE2 on all major EVM chains.
    address constant DAIMO_VERIFIER = 0xc2b78104907F722DABAc4C69f826a522B2754De4;

    /**
     * @notice Verify a P-256 signature using the best available method.
     * @dev Tries native precompile first, falls back to daimo verifier.
     */
    function verify(
        bytes32 hash,
        uint256 r,
        uint256 s,
        uint256 x,
        uint256 y
    ) internal view returns (bool) {
        bytes memory input = abi.encode(hash, r, s, x, y);

        // Try native RIP-7212 precompile first (~3,450 gas)
        (bool success, bytes memory result) = PRECOMPILE.staticcall(input);
        if (success && result.length == 32) {
            return abi.decode(result, (uint256)) == 1;
        }

        // Fallback to daimo Solidity verifier (~330K gas)
        (success, result) = DAIMO_VERIFIER.staticcall(input);
        if (success && result.length == 32) {
            return abi.decode(result, (uint256)) == 1;
        }

        return false;
    }
}
