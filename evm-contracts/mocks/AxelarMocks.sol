// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * Test doubles for the Axelar gateway and gas service, used only in local
 * unit tests (never deployed). The gateway mock approves every inbound
 * message by default so tests can drive BridgeHTLC.execute() directly,
 * simulating relay delivery of the Cosmos->EVM callback.
 */

contract MockAxelarGateway {
    bool public validateResult = true;

    event ContractCall(
        address indexed sender,
        string destinationChain,
        string destinationContractAddress,
        bytes32 indexed payloadHash,
        bytes payload
    );

    function setValidateResult(bool v) external {
        validateResult = v;
    }

    function callContract(
        string calldata destinationChain,
        string calldata contractAddress,
        bytes calldata payload
    ) external {
        emit ContractCall(msg.sender, destinationChain, contractAddress, keccak256(payload), payload);
    }

    function validateContractCall(
        bytes32, /*commandId*/
        string calldata, /*sourceChain*/
        string calldata, /*sourceAddress*/
        bytes32 /*payloadHash*/
    ) external view returns (bool) {
        return validateResult;
    }
}

contract MockAxelarGasService {
    event NativeGasPaidForContractCall(
        address indexed sourceAddress,
        string destinationChain,
        string destinationAddress,
        bytes32 indexed payloadHash,
        uint256 gasFeeAmount,
        address refundAddress
    );

    function payNativeGasForContractCall(
        address sender,
        string calldata destinationChain,
        string calldata destinationAddress,
        bytes calldata payload,
        address refundAddress
    ) external payable {
        emit NativeGasPaidForContractCall(
            sender, destinationChain, destinationAddress, keccak256(payload), msg.value, refundAddress
        );
    }
}

interface IBridgeHTLCLike {
    function claimBurn(bytes32 hashlock, bytes32 secret) external;
    function withdrawPending() external;
}

/// @dev Monitor contract that can be toggled to reject native transfers,
///      exercising the pull-payment fallback for bounty payouts.
contract TogglableMonitor {
    bool public acceptFunds;

    function setAccept(bool v) external {
        acceptFunds = v;
    }

    function doClaim(address bridge, bytes32 hashlock, bytes32 secret) external {
        IBridgeHTLCLike(bridge).claimBurn(hashlock, secret);
    }

    function doWithdraw(address bridge) external {
        IBridgeHTLCLike(bridge).withdrawPending();
    }

    receive() external payable {
        require(acceptFunds, "MockMonitor: rejecting funds");
    }
}
