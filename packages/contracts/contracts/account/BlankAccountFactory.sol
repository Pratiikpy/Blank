// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import "./BlankAccount.sol";

/**
 * @title BlankAccountFactory — CREATE2 factory for BlankAccount proxies
 * @notice One BlankAccount implementation, many user-specific proxies.
 *         createAccount is idempotent — if a proxy at the predicted address
 *         already exists, it's returned as-is. This is important for the
 *         ERC-4337 "counterfactual address" pattern: the frontend can compute
 *         the user's account address before deployment, then EntryPoint
 *         deploys lazily on the first UserOp.
 *
 * @dev Ported from Z0tz cctp-bridge (account/Z0tzAccountFactory.sol).
 */
contract BlankAccountFactory {
    BlankAccount public immutable accountImplementation;

    event AccountCreated(address indexed account, uint256 ownerX, uint256 ownerY);

    constructor(IEntryPoint _entryPoint) {
        accountImplementation = new BlankAccount(_entryPoint);
    }

    /// @notice Deploy (or return existing) BlankAccount proxy at the
    ///         CREATE2-determined address for these owner keys + salt.
    function createAccount(
        uint256 ownerX,
        uint256 ownerY,
        address recoveryModule,
        uint256 salt
    ) external returns (BlankAccount) {
        address predicted = getAddress(ownerX, ownerY, recoveryModule, salt);
        if (predicted.code.length > 0) {
            return BlankAccount(payable(predicted));
        }

        ERC1967Proxy proxy = new ERC1967Proxy{salt: bytes32(salt)}(
            address(accountImplementation),
            abi.encodeCall(
                BlankAccount.initialize,
                (ownerX, ownerY, recoveryModule)
            )
        );

        emit AccountCreated(address(proxy), ownerX, ownerY);
        return BlankAccount(payable(address(proxy)));
    }

    /// @notice Predict the account address for a given owner keypair + salt
    ///         WITHOUT deploying. Used by the frontend to render the user's
    ///         address before the first transaction.
    function getAddress(
        uint256 ownerX,
        uint256 ownerY,
        address recoveryModule,
        uint256 salt
    ) public view returns (address) {
        bytes32 bytecodeHash = keccak256(
            abi.encodePacked(
                type(ERC1967Proxy).creationCode,
                abi.encode(
                    address(accountImplementation),
                    abi.encodeCall(
                        BlankAccount.initialize,
                        (ownerX, ownerY, recoveryModule)
                    )
                )
            )
        );
        return address(uint160(uint256(keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                bytes32(salt),
                bytecodeHash
            )
        ))));
    }
}
