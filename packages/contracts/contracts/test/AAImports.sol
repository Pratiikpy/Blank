// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// This file exists ONLY to force hardhat to compile @account-abstraction
// dependencies that aren't directly imported by our application contracts.
// Specifically: the EntryPoint reference implementation, which our tests
// deploy locally as a stand-in for the real one (which lives at the
// canonical 0x4337... address on every chain in production).
//
// Without this re-export, getContractFactory("@account-abstraction/...") would
// fail with HH700 (artifact not found) because hardhat only compiles files in
// the dependency graph reachable from your contracts.

import "@account-abstraction/contracts/core/EntryPoint.sol";
