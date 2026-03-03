// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { ERC1155 } from '@openzeppelin/contracts/token/ERC1155/ERC1155.sol';
import { Ownable } from '@openzeppelin/contracts/access/Ownable.sol';

/**
 * @title IndicatorToken1155
 * @notice ERC-1155 multi-token for environmental indicators
 * @dev Each tokenId represents a semantic class (indicatorId)
 *      Tokens within same class are fungible; different classes are not
 * 
 * Design rationale:
 * - Prevents "semantic mixing" - tokens with different meanings can't be combined
 * - Each tokenId is bound to an indicatorId (hash of profile)
 * - Fungibility exists ONLY within the same semantic class
 */
contract IndicatorToken1155 is ERC1155, Ownable {
    
    // Mapping from tokenId to indicatorId (semantic binding)
    mapping(uint256 => bytes32) public tokenToIndicator;
    
    // Mapping from indicatorId to tokenId (reverse lookup)
    mapping(bytes32 => uint256) public indicatorToToken;
    
    // Whether a tokenId has been bound to an indicator
    mapping(uint256 => bool) public tokenBound;
    
    // Counter for auto-generating tokenIds
    uint256 public nextTokenId;
    
    // Authorized bridge contract
    address public bridge;
    
    // Token metadata
    struct IndicatorMetadata {
        string indicatorType;    // e.g., "CO2_REMOVAL", "ENERGY_CONSUMED"
        string unit;             // e.g., "kgCO2e", "kWh"
        string methodologyId;    // methodology identifier
        bytes32 profileHash;     // hash of full profile
        bytes32 dataHash;        // hash of evidence bundle
        uint256 createdAt;
    }
    
    mapping(uint256 => IndicatorMetadata) public metadata;
    
    event TokenClassCreated(
        uint256 indexed tokenId,
        bytes32 indexed indicatorId,
        string indicatorType,
        string unit
    );
    
    event BridgeSet(address indexed bridge);
    event TokensMinted(uint256 indexed tokenId, address indexed to, uint256 amount);
    event TokensBurned(uint256 indexed tokenId, address indexed from, uint256 amount);
    
    modifier onlyBridge() {
        require(msg.sender == bridge, "Only bridge can call");
        _;
    }
    
    constructor(string memory uri_) ERC1155(uri_) {
        nextTokenId = 1; // Start from 1, 0 is reserved
    }
    
    /**
     * @notice Sets the authorized bridge contract
     * @param bridge_ Address of the bridge contract
     */
    function setBridge(address bridge_) external onlyOwner {
        bridge = bridge_;
        emit BridgeSet(bridge_);
    }
    
    /**
     * @notice Creates a new token class bound to an indicator
     * @dev indicatorId = keccak256(abi.encodePacked(profileHash))
     * @param indicatorType Type of indicator
     * @param unit Canonical unit
     * @param methodologyId Methodology identifier
     * @param profileHash Hash of the full profile
     * @param dataHash Hash of evidence bundle
     * @return tokenId The new token ID
     */
    function createTokenClass(
        string calldata indicatorType,
        string calldata unit,
        string calldata methodologyId,
        bytes32 profileHash,
        bytes32 dataHash
    ) external onlyOwner returns (uint256 tokenId) {
        // Compute deterministic indicatorId
        bytes32 indicatorId = keccak256(abi.encodePacked(profileHash));
        
        // Check if this indicator already has a token
        require(indicatorToToken[indicatorId] == 0, "Indicator already has token class");
        
        tokenId = nextTokenId++;
        
        // Bind token to indicator (immutable)
        tokenToIndicator[tokenId] = indicatorId;
        indicatorToToken[indicatorId] = tokenId;
        tokenBound[tokenId] = true;
        
        // Store metadata
        metadata[tokenId] = IndicatorMetadata({
            indicatorType: indicatorType,
            unit: unit,
            methodologyId: methodologyId,
            profileHash: profileHash,
            dataHash: dataHash,
            createdAt: block.timestamp
        });
        
        emit TokenClassCreated(tokenId, indicatorId, indicatorType, unit);
        
        return tokenId;
    }
    
    /**
     * @notice Mints tokens (only bridge)
     * @dev FIX #7: Removed owner from mint authorization to prevent
     *      supply inflation outside the bridge protocol. Owner can only
     *      create token classes and configure the bridge.
     * @param to Recipient address
     * @param tokenId Token class ID
     * @param amount Amount to mint
     */
    function mint(address to, uint256 tokenId, uint256 amount) external onlyBridge {
        require(tokenBound[tokenId], "Token class not bound to indicator");
        require(amount > 0, "Amount must be > 0");
        
        _mint(to, tokenId, amount, "");
        emit TokensMinted(tokenId, to, amount);
    }
    
    /**
     * @notice Mints tokens for initial supply setup (owner-only, one-time)
     * @dev Separate function for initial token distribution before bridge is active
     * @param to Recipient address
     * @param tokenId Token class ID
     * @param amount Amount to mint
     */
    function mintInitialSupply(address to, uint256 tokenId, uint256 amount) external onlyOwner {
        require(tokenBound[tokenId], "Token class not bound to indicator");
        require(amount > 0, "Amount must be > 0");
        
        _mint(to, tokenId, amount, "");
        emit TokensMinted(tokenId, to, amount);
    }
    
    /**
     * @notice Burns tokens held by bridge contract itself
     * @dev FIX #8: Removed generic burn(from) that could burn from any address.
     *      Only escrowed tokens (held by bridge) can be burned.
     * @param tokenId Token class ID
     * @param amount Amount to burn
     */
    function burnFromBridge(uint256 tokenId, uint256 amount) external onlyBridge {
        _burn(bridge, tokenId, amount);
        emit TokensBurned(tokenId, bridge, amount);
    }
    
    /**
     * @notice Gets the indicatorId for a tokenId
     */
    function getIndicatorId(uint256 tokenId) external view returns (bytes32) {
        return tokenToIndicator[tokenId];
    }
    
    /**
     * @notice Gets the tokenId for an indicatorId
     */
    function getTokenId(bytes32 indicatorId) external view returns (uint256) {
        return indicatorToToken[indicatorId];
    }
    
    /**
     * @notice Gets full metadata for a token
     */
    function getMetadata(uint256 tokenId) external view returns (
        string memory indicatorType,
        string memory unit,
        string memory methodologyId,
        bytes32 profileHash,
        bytes32 dataHash,
        uint256 createdAt
    ) {
        IndicatorMetadata storage m = metadata[tokenId];
        return (m.indicatorType, m.unit, m.methodologyId, m.profileHash, m.dataHash, m.createdAt);
    }
}
