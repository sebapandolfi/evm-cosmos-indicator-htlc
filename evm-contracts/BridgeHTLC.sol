// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { AxelarExecutable } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/executable/AxelarExecutable.sol';
import { IAxelarGasService } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/interfaces/IAxelarGasService.sol';
import { AddressToString } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/libs/AddressString.sol';
import { IERC1155 } from '@openzeppelin/contracts/token/ERC1155/IERC1155.sol';

interface IIndicatorToken1155 {
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
    function burnFromBridge(uint256 tokenId, uint256 amount) external;
    function mint(address to, uint256 tokenId, uint256 amount) external;
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
        uint256 bounty;          // Native-token bounty escrowed for whoever finalises the burn
    }

    // Locks indexed by hashlock
    mapping(bytes32 => HTLCLock) public locks;
    
    // User's active locks
    mapping(address => bytes32[]) public userLocks;
    
    // Revealed secrets (for verification)
    mapping(bytes32 => bytes32) public revealedSecrets; // hashlock => secret

    // Pull-payment fallback for bounty transfers that fail (e.g., recipient reverts)
    mapping(address => uint256) public pendingWithdrawals;

    // ============ Reverse direction (Cosmos -> EVM): pending mints ============

    enum MintState { EMPTY, PENDING, MINTED, REFUNDED }

    struct PendingMint {
        uint256 tokenId;
        uint256 amount;
        address recipient;
        bytes32 indicatorId;     // semantic binding, validated against the token contract
        uint256 timeout;         // claim deadline T_c on this chain (unix seconds)
        string sourceChain;      // for the automatic burn callback
        string sourceAddress;
        MintState state;
    }

    /// @dev Pending mints (this chain acting as HTLC destination), indexed by hashlock
    mapping(bytes32 => PendingMint) public pendingMints;

    /// @dev Contract owner (may configure the authorized inbound source)
    address public owner;

    /// @dev Only prepare-mint messages from this counterpart are accepted
    string public authorizedSourceChain;
    string public authorizedSourceAddress;

    /// @dev Protocol-minimum bounty. Without a floor, an adversarial sender
    ///      sets bounty = 0 and deliberately induces callback failure
    ///      (e.g., by mis-funding the callback relay fee), then refunds after
    ///      T_e while keeping the destination mint. A minimum bounty sized
    ///      above the monitor's claimBurn execution cost makes that attack
    ///      fund its own defeat: the secret is public after the destination
    ///      claim and claimBurn is permissionless, so any rational observer
    ///      profits from finalising the burn. Owner-adjustable as gas prices
    ///      drift.
    uint256 public minBounty;

    event MinBountySet(uint256 minBounty);

    /// @dev Tag for inbound tagged messages (first ABI word). 64-byte untagged
    ///      payloads are treated as legacy burn callbacks.
    uint256 public constant MSG_PREPARE_MINT = 2;

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

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
        string cosmosRecipient,
        uint256 bounty
    );

    event BountyPaid(
        bytes32 indexed hashlock,
        address indexed recipient,
        uint256 amount,
        bool credited // true if credited to pendingWithdrawals instead of sent
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

    // Reverse-direction events (this chain as HTLC destination)
    event MintPrepared(
        bytes32 indexed hashlock,
        uint256 tokenId,
        uint256 amount,
        address indexed recipient,
        uint256 timeout
    );

    event MintClaimed(
        bytes32 indexed hashlock,
        bytes32 secret,
        address indexed recipient
    );

    event MintRefunded(bytes32 indexed hashlock);

    event AuthorizedSourceSet(string sourceChain, string sourceAddress);

    constructor(
        address gateway_,
        address gasService_,
        address token_,
        string memory chainName_
    ) AxelarExecutable(gateway_) {
        gasService = IAxelarGasService(gasService_);
        token = IIndicatorToken1155(token_);
        chainName = chainName_;
        owner = msg.sender;
        // Default floor: ~3x the claimBurn gas cost at elevated gas prices;
        // adjust via setMinBounty as market conditions change.
        minBounty = 0.05 ether;
    }

    /**
     * @notice Adjust the protocol-minimum bounty (owner-only).
     */
    function setMinBounty(uint256 minBounty_) external onlyOwner {
        minBounty = minBounty_;
        emit MinBountySet(minBounty_);
    }

    /**
     * @notice Configure the counterpart contract allowed to prepare mints
     *         (reverse direction, Cosmos -> EVM).
     */
    function setAuthorizedSource(
        string calldata sourceChain,
        string calldata sourceAddress
    ) external onlyOwner {
        authorizedSourceChain = sourceChain;
        authorizedSourceAddress = sourceAddress;
        emit AuthorizedSourceSet(sourceChain, sourceAddress);
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
     * @param bounty Portion of msg.value escrowed as a bounty, payable to
     *        whoever finalises the source-side burn via claimBurn(). Returned
     *        to the sender if the automatic callback executes the burn, or on
     *        refund. Makes supply conservation incentive-compatible (A4).
     */
    function lockForBurn(
        uint256 tokenId,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock,
        string calldata cosmosRecipient,
        string calldata destinationChain,
        string calldata destinationAddress,
        uint256 bounty
    ) external payable nonReentrant {
        // --- Checks ---
        require(amount > 0, "Amount must be > 0");
        require(hashlock != bytes32(0), "Invalid hashlock");
        // FIX #4: Enforce minimum timelock duration
        require(timelock >= block.timestamp + MIN_TIMELOCK_DURATION, "Timelock too short (min 1 hour)");
        require(timelock <= block.timestamp + 7 days, "Timelock too far in future");
        require(locks[hashlock].state == LockState.EMPTY, "Hashlock already used");
        require(bounty >= minBounty, "Bounty below protocol minimum");
        require(msg.value > bounty, "msg.value must cover bounty plus GMP gas");
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
            state: LockState.LOCKED,
            bounty: bounty
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

        // Pay gas and send via Axelar (bounty stays escrowed in this contract)
        gasService.payNativeGasForContractCall{value: msg.value - bounty}(
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
            cosmosRecipient,
            bounty
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

        // Pay the bounty to whoever finalised the burn (the monitor).
        // This makes A4 incentive-compatible: the motivated set is any
        // rational observer of the destination chain, not just altruists.
        // v1.1: grace period. Before the destination claim deadline T_c the
        // automatic callback may still be in flight, so a third party that
        // races it is not paid: the burn goes through and the bounty returns
        // to the sender. From T_c on, the bounty pays the caller as before.
        address payee = block.timestamp >= lock.timelock - COSMOS_TIMEOUT_BUFFER
            ? msg.sender
            : lock.sender;
        _payBounty(hashlock, payee);

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

        // Return the unspent bounty to the sender
        _payBounty(hashlock, lock.sender);

        emit LockRefunded(hashlock, lock.sender, lock.tokenId, lock.amount);
    }

    /**
     * @notice Pay out (or return) the escrowed bounty for a lock.
     * @dev Zeroes the stored bounty before transferring (checks-effects-
     *      interactions). If the native transfer fails (e.g., recipient is a
     *      contract that reverts), the amount is credited to
     *      pendingWithdrawals so the burn/refund can never be blocked.
     */
    function _payBounty(bytes32 hashlock, address recipient) internal {
        uint256 amount = locks[hashlock].bounty;
        if (amount == 0) return;
        locks[hashlock].bounty = 0;

        (bool ok, ) = payable(recipient).call{value: amount, gas: 30000}("");
        if (!ok) {
            pendingWithdrawals[recipient] += amount;
        }
        emit BountyPaid(hashlock, recipient, amount, !ok);
    }

    /**
     * @notice Withdraw bounty amounts that could not be transferred directly.
     */
    function withdrawPending() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        pendingWithdrawals[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Withdraw failed");
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
        
        // v1.1: Axelar GMP payload version 0x00000001 (ABI-encoded CosmWasm
        // call). With this version Axelar converts the call to the JSON
        // message {"prepare_mint": {...}} and validates the source_chain and
        // source_address arguments, so the receiver can authenticate the
        // emitting contract instead of only the IBC route. The JSON shape the
        // receiver sees is the same as with the 0x00000002 encoding of v1.0.
        string[] memory names = new string[](8);
        names[0] = "hashlock"; names[1] = "indicator_id"; names[2] = "token_id";
        names[3] = "amount"; names[4] = "cosmos_recipient"; names[5] = "timeout";
        names[6] = "source_chain"; names[7] = "source_address";
        string[] memory types = new string[](8);
        for (uint256 i = 0; i < 8; i++) { types[i] = "string"; }
        bytes memory argValues = abi.encode(
            hashlockHex,
            indicatorIdHex,
            _uint256ToString(tokenId),
            _uint256ToString(amount),
            cosmosRecipient,
            _uint256ToString(cosmosTimeout),
            chainName,
            address(this).toString()
        );
        return abi.encodePacked(bytes4(0x00000001), abi.encode("prepare_mint", names, types, argValues));
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
        if (payload.length < 64) {
            emit CallbackIgnored(bytes32(0), "Invalid payload length");
            return;
        }

        // Tagged messages (reverse direction). 64-byte payloads are legacy
        // burn callbacks; anything longer carries a type tag in word 0.
        if (payload.length > 64) {
            uint256 msgType = abi.decode(payload[:32], (uint256));
            if (msgType == MSG_PREPARE_MINT) {
                _handlePrepareMint(sourceChain, sourceAddress, payload);
            } else {
                emit CallbackIgnored(bytes32(0), "Unknown message type");
            }
            return;
        }

        // Legacy path: burn callback, ABI-encoded (hashlock, secret)
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

        // Automatic callback executed the burn: no monitor was needed, so the
        // bounty is returned to the original sender.
        _payBounty(hashlock, lock.sender);

        emit CallbackBurnProcessed(hashlock, secret, sourceChain);
        emit LockClaimed(hashlock, secret, address(this));
    }

    // ============ Reverse direction: Cosmos -> EVM transfer ============

    /**
     * @notice Handle an inbound prepare-mint message (this chain is the HTLC
     *         destination). Payload: abi.encode(uint256 MSG_PREPARE_MINT,
     *         bytes32 hashlock, bytes32 indicatorId, uint256 tokenId,
     *         uint256 amount, address recipient, uint256 timeout).
     * @dev Mirrors the CosmWasm prepare_mint checks: authorized counterpart,
     *      registered class with matching semantic identity, future timeout,
     *      fresh hashlock. Invalid messages are ignored without state change
     *      (the source escrow is then recoverable by refund after T_e).
     */
    function _handlePrepareMint(
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes calldata payload
    ) internal {
        if (payload.length != 224) {
            emit CallbackIgnored(bytes32(0), "Invalid prepare payload length");
            return;
        }

        // Authorization: only the configured counterpart may prepare mints
        if (keccak256(bytes(sourceChain)) != keccak256(bytes(authorizedSourceChain)) ||
            keccak256(bytes(sourceAddress)) != keccak256(bytes(authorizedSourceAddress))) {
            emit CallbackIgnored(bytes32(0), "Unauthorized prepare source");
            return;
        }

        (
            ,
            bytes32 hashlock,
            bytes32 indicatorId,
            uint256 tokenId,
            uint256 amount,
            address recipient,
            uint256 timeout
        ) = abi.decode(payload, (uint256, bytes32, bytes32, uint256, uint256, address, uint256));

        if (pendingMints[hashlock].state != MintState.EMPTY || locks[hashlock].state != LockState.EMPTY) {
            emit CallbackIgnored(hashlock, "Hashlock already used");
            return;
        }
        if (amount == 0 || recipient == address(0) || timeout <= block.timestamp) {
            emit CallbackIgnored(hashlock, "Invalid prepare parameters");
            return;
        }

        // Semantic validation: class must be registered on this chain with the
        // same content-addressed identity (prevents semantic mixing).
        bytes32 localIndicatorId = token.getIndicatorId(tokenId);
        if (localIndicatorId == bytes32(0) || localIndicatorId != indicatorId) {
            emit CallbackIgnored(hashlock, "Unregistered or mismatched class");
            return;
        }

        pendingMints[hashlock] = PendingMint({
            tokenId: tokenId,
            amount: amount,
            recipient: recipient,
            indicatorId: indicatorId,
            timeout: timeout,
            sourceChain: sourceChain,
            sourceAddress: sourceAddress,
            state: MintState.PENDING
        });

        emit MintPrepared(hashlock, tokenId, amount, recipient, timeout);
    }

    /**
     * @notice Claim a pending mint by revealing the secret (reverse direction).
     * @dev Mints to the recorded recipient and emits the automatic burn
     *      callback to the Cosmos source via Axelar GMP. msg.value funds the
     *      callback relay leg (destination execution gas on the source chain).
     */
    function claimMint(bytes32 hashlock, bytes32 secret) external payable nonReentrant {
        PendingMint storage pm = pendingMints[hashlock];

        require(pm.state == MintState.PENDING, "No pending mint");
        require(block.timestamp < pm.timeout, "Claim window expired");
        require(keccak256(abi.encodePacked(secret)) == hashlock, "Invalid secret");

        pm.state = MintState.MINTED;
        revealedSecrets[hashlock] = secret;

        token.mint(pm.recipient, pm.tokenId, pm.amount);

        // Automatic burn callback to the Cosmos source (JSON for CosmWasm)
        bytes memory payload = abi.encodePacked(
            bytes4(0x00000002),
            bytes(_encodeClaimBurnJson(hashlock, secret))
        );
        if (msg.value > 0) {
            gasService.payNativeGasForContractCall{value: msg.value}(
                address(this), pm.sourceChain, pm.sourceAddress, payload, msg.sender
            );
        }
        gateway().callContract(pm.sourceChain, pm.sourceAddress, payload);

        emit MintClaimed(hashlock, secret, pm.recipient);
    }

    /**
     * @notice Cancel a pending mint after its claim window expires.
     * @dev Permissionless, mirroring the CosmWasm refund_mint: nothing was
     *      minted, so this only frees the hashlock state on this chain.
     */
    function refundMint(bytes32 hashlock) external nonReentrant {
        PendingMint storage pm = pendingMints[hashlock];

        require(pm.state == MintState.PENDING, "No pending mint");
        require(block.timestamp >= pm.timeout, "Claim window still open");

        pm.state = MintState.REFUNDED;

        emit MintRefunded(hashlock);
    }

    /**
     * @notice Encode the claim_burn execute message consumed by the CosmWasm
     *         source contract on the reverse path.
     */
    function _encodeClaimBurnJson(bytes32 hashlock, bytes32 secret) internal pure returns (string memory) {
        return string(abi.encodePacked(
            '{"claim_burn":{',
            '"hashlock":"', _bytes32ToHexString(hashlock), '",',
            '"secret":"', _bytes32ToHexString(secret), '"',
            '}}'
        ));
    }

    function getPendingMint(bytes32 hashlock) external view returns (
        uint256 tokenId,
        uint256 amount,
        address recipient,
        bytes32 indicatorId,
        uint256 timeout,
        MintState state
    ) {
        PendingMint storage pm = pendingMints[hashlock];
        return (pm.tokenId, pm.amount, pm.recipient, pm.indicatorId, pm.timeout, pm.state);
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
        LockState state,
        uint256 bounty
    ) {
        HTLCLock storage lock = locks[hashlock];
        return (
            lock.sender,
            lock.tokenId,
            lock.amount,
            lock.timelock,
            lock.cosmosRecipient,
            lock.state,
            lock.bounty
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
