// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { AxelarExecutable } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/executable/AxelarExecutable.sol';
import { IAxelarGasService } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/interfaces/IAxelarGasService.sol';
import { AddressToString } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/libs/AddressString.sol';
import { IERC1155 } from '@openzeppelin/contracts/token/ERC1155/IERC1155.sol';

interface IIndicatorToken1155 {
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
    function burnFromBridge(uint256 tokenId, uint256 amount) external;
    function balanceOf(address account, uint256 id) external view returns (uint256);
    function getIndicatorId(uint256 tokenId) external view returns (bytes32);
}

/// @dev Minimal reentrancy guard
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    constructor() { _status = _NOT_ENTERED; }

    modifier nonReentrant() {
        require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}

/**
 * @title BridgeHTLC
 * @notice Hash Time Locked Contract Bridge for atomic cross-chain transfers
 * @dev Uses HTLC pattern: tokens are locked with a hashlock, released when secret is revealed
 * 
 * Flow (EVM → Cosmos):
 * 1. User generates secret S, computes H = keccak256(S)
 * 2. User calls lockForBurn(tokenId, amount, H, timeout, cosmosRecipient)
 *    - Tokens transferred to this contract (escrow)
 *    - GMP sent to Cosmos with H and timeout
 * 3. Cosmos registers pending mint with H
 * 4. User reveals S on Cosmos: claimMint(S) → verifies hash(S)==H → mints
 * 5. S is now PUBLIC on Cosmos blockchain
 * 6. Anyone calls claimBurn(H, S) on EVM → verifies → burns escrowed tokens
 * 
 * Timeout paths:
 * - Cosmos: after timeout, refundMint() cancels pending (nothing minted)
 * - EVM: after timeout, refundBurn(H) unlocks tokens back to user
 */
contract BridgeHTLC is AxelarExecutable, ReentrancyGuard {
    using AddressToString for address;

    IAxelarGasService public immutable gasService;
    IIndicatorToken1155 public immutable token;
    string public chainName;

    /// @dev FIX #4: Minimum timelock duration (1 hour)
    uint256 public constant MIN_TIMELOCK_DURATION = 1 hours;
    
    /// @dev Buffer between Cosmos timeout and EVM timeout
    uint256 public constant COSMOS_TIMEOUT_BUFFER = 30 minutes;

    // HTLC lock states
    enum LockState { EMPTY, LOCKED, CLAIMED, REFUNDED }

    struct HTLCLock {
        address sender;
        uint256 tokenId;
        uint256 amount;
        bytes32 hashlock;        // H = keccak256(secret)
        uint256 timelock;        // Unix timestamp after which refund is possible
        string cosmosRecipient;
        string destinationChain;
        string destinationAddress;
        LockState state;
    }

    // Locks indexed by hashlock
    mapping(bytes32 => HTLCLock) public locks;
    
    // User's active locks
    mapping(address => bytes32[]) public userLocks;
    
    // Revealed secrets (for verification)
    mapping(bytes32 => bytes32) public revealedSecrets; // hashlock => secret

    // Stats
    uint256 public totalLocked;
    uint256 public totalClaimed;
    uint256 public totalRefunded;

    event LockCreated(
        bytes32 indexed hashlock,
        address indexed sender,
        uint256 tokenId,
        uint256 amount,
        uint256 timelock,
        string cosmosRecipient
    );

    event LockClaimed(
        bytes32 indexed hashlock,
        bytes32 secret,
        address claimer
    );

    event LockRefunded(
        bytes32 indexed hashlock,
        address indexed sender,
        uint256 tokenId,
        uint256 amount
    );

    event CallbackBurnProcessed(
        bytes32 indexed hashlock,
        bytes32 secret,
        string sourceChain
    );

    event CallbackIgnored(
        bytes32 indexed hashlock,
        string reason
    );

    constructor(
        address gateway_,
        address gasService_,
        address token_,
        string memory chainName_
    ) AxelarExecutable(gateway_) {
        gasService = IAxelarGasService(gasService_);
        token = IIndicatorToken1155(token_);
        chainName = chainName_;
    }

    /**
     * @notice Lock tokens with a hashlock for cross-chain transfer
     * @param tokenId ERC-1155 token class ID
     * @param amount Amount to lock
     * @param hashlock H = keccak256(secret) - user generates secret off-chain
     * @param timelock Unix timestamp after which user can refund
     * @param cosmosRecipient Cosmos address (bech32) to receive minted tokens
     * @param destinationChain Axelar chain name (e.g., "neutron")
     * @param destinationAddress CosmWasm contract address
     */
    function lockForBurn(
        uint256 tokenId,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock,
        string calldata cosmosRecipient,
        string calldata destinationChain,
        string calldata destinationAddress
    ) external payable nonReentrant {
        // --- Checks ---
        require(amount > 0, "Amount must be > 0");
        require(hashlock != bytes32(0), "Invalid hashlock");
        // FIX #4: Enforce minimum timelock duration
        require(timelock >= block.timestamp + MIN_TIMELOCK_DURATION, "Timelock too short (min 1 hour)");
        require(timelock <= block.timestamp + 7 days, "Timelock too far in future");
        require(locks[hashlock].state == LockState.EMPTY, "Hashlock already used");
        require(msg.value > 0, "Gas payment required for GMP");
        // FIX #3: Validate cosmosRecipient format (bech32-safe chars only)
        require(_isValidBech32Recipient(cosmosRecipient), "Invalid recipient format");
        require(bytes(destinationChain).length > 0, "Invalid destination chain");
        require(bytes(destinationAddress).length > 0, "Invalid destination address");

        // Get indicatorId for semantic binding (read-only, safe before state update)
        bytes32 indicatorId = token.getIndicatorId(tokenId);

        // --- Effects (FIX #6: update state BEFORE external calls) ---
        locks[hashlock] = HTLCLock({
            sender: msg.sender,
            tokenId: tokenId,
            amount: amount,
            hashlock: hashlock,
            timelock: timelock,
            cosmosRecipient: cosmosRecipient,
            destinationChain: destinationChain,
            destinationAddress: destinationAddress,
            state: LockState.LOCKED
        });

        userLocks[msg.sender].push(hashlock);
        totalLocked += amount;

        // --- Interactions ---
        // Transfer tokens to this contract (escrow)
        token.safeTransferFrom(msg.sender, address(this), tokenId, amount, "");

        // Prepare GMP payload for Cosmos
        // FIX #4: Cosmos timeout uses constant buffer
        uint256 cosmosTimeout = timelock - COSMOS_TIMEOUT_BUFFER;
        
        bytes memory payload = _encodePrepareMintPayload(
            hashlock,
            indicatorId,
            tokenId,
            amount,
            cosmosRecipient,
            cosmosTimeout
        );

        // Pay gas and send via Axelar
        gasService.payNativeGasForContractCall{value: msg.value}(
            address(this),
            destinationChain,
            destinationAddress,
            payload,
            msg.sender
        );

        gateway().callContract(destinationChain, destinationAddress, payload);

        emit LockCreated(
            hashlock,
            msg.sender,
            tokenId,
            amount,
            timelock,
            cosmosRecipient
        );
    }

    /**
     * @notice Claim locked tokens by revealing the secret
     * @dev Anyone can call this once the secret is revealed on Cosmos
     * @param hashlock The hashlock of the HTLC
     * @param secret The preimage such that keccak256(secret) == hashlock
     */
    function claimBurn(bytes32 hashlock, bytes32 secret) external nonReentrant {
        HTLCLock storage lock = locks[hashlock];
        
        require(lock.state == LockState.LOCKED, "Lock not in LOCKED state");
        require(keccak256(abi.encodePacked(secret)) == hashlock, "Invalid secret");

        // Update state BEFORE external calls (reentrancy protection)
        lock.state = LockState.CLAIMED;
        revealedSecrets[hashlock] = secret;
        totalClaimed += lock.amount;

        // Burn the escrowed tokens (they were successfully minted on Cosmos)
        token.burnFromBridge(lock.tokenId, lock.amount);

        emit LockClaimed(hashlock, secret, msg.sender);
    }

    /**
     * @notice Refund locked tokens after timeout
     * @dev Only the original sender can refund, and only after timelock expires
     * @param hashlock The hashlock of the HTLC to refund
     */
    function refundBurn(bytes32 hashlock) external nonReentrant {
        HTLCLock storage lock = locks[hashlock];
        
        require(lock.state == LockState.LOCKED, "Lock not in LOCKED state");
        require(block.timestamp >= lock.timelock, "Timelock not expired");
        require(msg.sender == lock.sender, "Only sender can refund");

        // Update state BEFORE external calls
        lock.state = LockState.REFUNDED;
        totalRefunded += lock.amount;

        // Return tokens to sender
        token.safeTransferFrom(address(this), lock.sender, lock.tokenId, lock.amount, "");

        emit LockRefunded(hashlock, lock.sender, lock.tokenId, lock.amount);
    }

    /**
     * @notice Encode payload for Cosmos prepare_mint
     */
    function _encodePrepareMintPayload(
        bytes32 hashlock,
        bytes32 indicatorId,
        uint256 tokenId,
        uint256 amount,
        string memory cosmosRecipient,
        uint256 cosmosTimeout
    ) internal view returns (bytes memory) {
        // Convert bytes32 to hex string for JSON
        string memory hashlockHex = _bytes32ToHexString(hashlock);
        string memory indicatorIdHex = _bytes32ToHexString(indicatorId);
        
        string memory jsonPayload = string(abi.encodePacked(
            '{"prepare_mint":{',
            '"hashlock":"', hashlockHex, '",',
            '"indicator_id":"', indicatorIdHex, '",',
            '"token_id":"', _uint256ToString(tokenId), '",',
            '"amount":"', _uint256ToString(amount), '",',
            '"cosmos_recipient":"', cosmosRecipient, '",',
            '"timeout":"', _uint256ToString(cosmosTimeout), '",',
            '"source_chain":"', chainName, '",',
            '"source_address":"', address(this).toString(), '"',
            '}}'
        ));
        
        // Axelar GMP Version 0x00000002 (JSON direct)
        return abi.encodePacked(bytes4(0x00000002), bytes(jsonPayload));
    }

    /**
     * @notice Convert bytes32 to hex string (with 0x prefix)
     */
    function _bytes32ToHexString(bytes32 data) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(66); // 0x + 64 hex chars
        str[0] = '0';
        str[1] = 'x';
        for (uint256 i = 0; i < 32; i++) {
            str[2 + i * 2] = alphabet[uint8(data[i] >> 4)];
            str[3 + i * 2] = alphabet[uint8(data[i] & 0x0f)];
        }
        return string(str);
    }

    /**
     * @notice Convert uint256 to string
     */
    function _uint256ToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    /**
     * @notice Handle incoming GMP callback from Cosmos
     * @dev When a user claims on Cosmos (revealing the secret), the Cosmos
     *      contract automatically sends a GMP callback to burn the escrowed
     *      tokens on EVM. This closes the HTLC timeout race condition.
     *      
     *      The manual claimBurn() function is kept as a fallback.
     *      
     * @param sourceChain The chain that sent the callback (e.g., "neutron")
     * @param sourceAddress The CosmWasm contract that sent the callback
     * @param payload ABI-encoded (bytes32 hashlock, bytes32 secret)
     */
    function _execute(
        bytes32 /*commandId*/,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes calldata payload
    ) internal override {
        // Decode payload: (hashlock, secret)
        if (payload.length < 64) {
            emit CallbackIgnored(bytes32(0), "Invalid payload length");
            return;
        }

        (bytes32 hashlock, bytes32 secret) = abi.decode(payload, (bytes32, bytes32));

        HTLCLock storage lock = locks[hashlock];

        // If lock is not LOCKED, it was already claimed manually or refunded
        if (lock.state != LockState.LOCKED) {
            emit CallbackIgnored(hashlock, "Lock not in LOCKED state");
            return;
        }

        // Verify the secret matches the hashlock
        if (keccak256(abi.encodePacked(secret)) != hashlock) {
            emit CallbackIgnored(hashlock, "Invalid secret");
            return;
        }

        // Execute the burn (same logic as claimBurn but via callback)
        lock.state = LockState.CLAIMED;
        revealedSecrets[hashlock] = secret;
        totalClaimed += lock.amount;

        token.burnFromBridge(lock.tokenId, lock.amount);

        emit CallbackBurnProcessed(hashlock, secret, sourceChain);
        emit LockClaimed(hashlock, secret, address(this));
    }

    /**
     * @notice FIX #3: Validate bech32-safe characters in recipient
     * @dev Bech32 addresses only contain: a-z, 0-9 (lowercase alphanumeric)
     *      Must be between 10 and 128 characters
     */
    function _isValidBech32Recipient(string calldata recipient) internal pure returns (bool) {
        bytes memory b = bytes(recipient);
        if (b.length < 10 || b.length > 128) return false;
        
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 char = b[i];
            // Allow lowercase letters, digits, and '1' separator
            bool isLower = (char >= 0x61 && char <= 0x7A); // a-z
            bool isDigit = (char >= 0x30 && char <= 0x39); // 0-9
            if (!isLower && !isDigit) return false;
        }
        return true;
    }

    /**
     * @notice ERC1155 receiver hook
     */
    function onERC1155Received(
        address /*operator*/,
        address /*from*/,
        uint256 /*id*/,
        uint256 /*value*/,
        bytes calldata /*data*/
    ) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    /**
     * @notice FIX #9: ERC1155 batch receiver hook
     */
    function onERC1155BatchReceived(
        address /*operator*/,
        address /*from*/,
        uint256[] calldata /*ids*/,
        uint256[] calldata /*values*/,
        bytes calldata /*data*/
    ) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    // ============ View Functions ============

    function getLock(bytes32 hashlock) external view returns (
        address sender,
        uint256 tokenId,
        uint256 amount,
        uint256 timelock,
        string memory cosmosRecipient,
        LockState state
    ) {
        HTLCLock storage lock = locks[hashlock];
        return (
            lock.sender,
            lock.tokenId,
            lock.amount,
            lock.timelock,
            lock.cosmosRecipient,
            lock.state
        );
    }

    function getUserLocks(address user) external view returns (bytes32[] memory) {
        return userLocks[user];
    }

    function isLockActive(bytes32 hashlock) external view returns (bool) {
        return locks[hashlock].state == LockState.LOCKED;
    }

    function canRefund(bytes32 hashlock) external view returns (bool) {
        HTLCLock storage lock = locks[hashlock];
        return lock.state == LockState.LOCKED && block.timestamp >= lock.timelock;
    }

    function getRevealedSecret(bytes32 hashlock) external view returns (bytes32) {
        return revealedSecrets[hashlock];
    }
}
