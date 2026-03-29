// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @title TokenRegistry — Maps ERC20 tokens to their FHERC20Vault wrappers
/// @notice The frontend queries this to discover which tokens can be shielded
///         and their corresponding vault addresses.
contract TokenRegistry is UUPSUpgradeable, OwnableUpgradeable {
    struct TokenInfo {
        address vault;          // FHERC20Vault address
        address underlying;     // Original ERC20 address
        string name;            // Display name (e.g., "Encrypted USDC")
        string symbol;          // Display symbol (e.g., "eUSDC")
        uint8 decimals;         // Token decimals
        bool active;            // Can be deactivated without removing
    }

    TokenInfo[] private _tokens;
    mapping(address => uint256) public vaultToIndex;     // vault address → index+1 (0 means not found)
    mapping(address => uint256) public underlyingToIndex; // underlying address → index+1

    event TokenRegistered(address indexed vault, address indexed underlying, string symbol);
    event TokenDeactivated(address indexed vault);
    event TokenReactivated(address indexed vault);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize() public initializer {
        __Ownable_init(msg.sender);
        // UUPSUpgradeable needs no init in OZ v5.6
    }

    /// @notice Register a new token + vault pair
    function registerToken(
        address vault,
        address underlying,
        string calldata name,
        string calldata symbol,
        uint8 tokenDecimals
    ) external onlyOwner {
        require(vaultToIndex[vault] == 0, "TokenRegistry: vault already registered");
        require(underlyingToIndex[underlying] == 0, "TokenRegistry: underlying already registered");

        _tokens.push(TokenInfo({
            vault: vault,
            underlying: underlying,
            name: name,
            symbol: symbol,
            decimals: tokenDecimals,
            active: true
        }));

        uint256 index = _tokens.length; // 1-indexed
        vaultToIndex[vault] = index;
        underlyingToIndex[underlying] = index;

        emit TokenRegistered(vault, underlying, symbol);
    }

    /// @notice Deactivate a token (keeps data, hides from active list)
    function deactivateToken(address vault) external onlyOwner {
        uint256 idx = vaultToIndex[vault];
        require(idx != 0, "TokenRegistry: vault not found");
        _tokens[idx - 1].active = false;
        emit TokenDeactivated(vault);
    }

    /// @notice Reactivate a deactivated token
    function reactivateToken(address vault) external onlyOwner {
        uint256 idx = vaultToIndex[vault];
        require(idx != 0, "TokenRegistry: vault not found");
        _tokens[idx - 1].active = true;
        emit TokenReactivated(vault);
    }

    /// @notice Get all active tokens
    function getActiveTokens() external view returns (TokenInfo[] memory) {
        uint256 activeCount = 0;
        for (uint256 i = 0; i < _tokens.length; i++) {
            if (_tokens[i].active) activeCount++;
        }

        TokenInfo[] memory result = new TokenInfo[](activeCount);
        uint256 j = 0;
        for (uint256 i = 0; i < _tokens.length; i++) {
            if (_tokens[i].active) {
                result[j] = _tokens[i];
                j++;
            }
        }
        return result;
    }

    /// @notice Get token info by vault address
    function getTokenByVault(address vault) external view returns (TokenInfo memory) {
        uint256 idx = vaultToIndex[vault];
        require(idx != 0, "TokenRegistry: vault not found");
        return _tokens[idx - 1];
    }

    /// @notice Get token info by underlying ERC20 address
    function getTokenByUnderlying(address underlying) external view returns (TokenInfo memory) {
        uint256 idx = underlyingToIndex[underlying];
        require(idx != 0, "TokenRegistry: underlying not found");
        return _tokens[idx - 1];
    }

    /// @notice Get total number of registered tokens
    function tokenCount() external view returns (uint256) {
        return _tokens.length;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
