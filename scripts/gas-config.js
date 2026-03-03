/**
 * Gas configuration for Polygon Mainnet
 * 
 * Uses aggressive settings to ensure fast confirmation.
 * Public Polygon RPCs often report unreliable gas estimates,
 * so we use fixed high values that guarantee inclusion.
 */

const { ethers } = require('ethers');

// Aggressive gas settings for instant confirmation on Polygon
// These are higher than typical but ensure transactions don't get stuck
const GAS_CONFIG = {
    // EIP-1559 settings
    maxFeePerGas: ethers.utils.parseUnits('500', 'gwei'),      // Max we're willing to pay
    maxPriorityFeePerGas: ethers.utils.parseUnits('100', 'gwei'), // Tip to validators
    
    // Gas limits for different operations
    limits: {
        deploy1155: 3500000,      // IndicatorToken1155 deployment
        deployBridge: 4000000,    // BridgeHTLC deployment
        lockForBurn: 800000,      // Lock tokens (includes GMP call)
        claimBurn: 300000,        // Claim/burn tokens
        refundBurn: 200000,       // Refund tokens
        approve: 100000,          // ERC-1155 approval
        transfer: 150000,         // Token transfer
        createClass: 200000,      // Create token class
        mint: 200000,             // Mint tokens
    }
};

/**
 * Get gas settings for a transaction
 * @param {string} operation - Operation type (e.g., 'lockForBurn', 'claimBurn')
 * @param {object} overrides - Optional overrides
 * @returns {object} Gas settings for ethers.js
 */
function getGasSettings(operation, overrides = {}) {
    const gasLimit = GAS_CONFIG.limits[operation] || 500000;
    
    return {
        maxFeePerGas: overrides.maxFeePerGas || GAS_CONFIG.maxFeePerGas,
        maxPriorityFeePerGas: overrides.maxPriorityFeePerGas || GAS_CONFIG.maxPriorityFeePerGas,
        gasLimit: overrides.gasLimit || gasLimit,
        ...overrides
    };
}

/**
 * Get provider with explicit Polygon network config
 * Avoids network detection issues with public RPCs
 */
function getPolygonProvider(rpcUrl = 'https://polygon-bor-rpc.publicnode.com') {
    return new ethers.providers.JsonRpcProvider(rpcUrl, {
        name: 'polygon',
        chainId: 137
    });
}

/**
 * Format gas info for logging
 */
function formatGasInfo(settings) {
    return {
        maxFeePerGas: ethers.utils.formatUnits(settings.maxFeePerGas, 'gwei') + ' gwei',
        maxPriorityFeePerGas: ethers.utils.formatUnits(settings.maxPriorityFeePerGas, 'gwei') + ' gwei',
        gasLimit: settings.gasLimit?.toString() || 'auto'
    };
}

module.exports = {
    GAS_CONFIG,
    getGasSettings,
    getPolygonProvider,
    formatGasInfo
};
