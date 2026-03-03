/**
 * Deploy HTLC Bridge contracts on Polygon Mainnet
 * 
 * Deploys:
 * 1. IndicatorToken1155 - ERC-1155 multi-token with semantic binding
 * 2. BridgeHTLC - Hash Time-Locked Contract bridge
 * 
 * Usage: node deploy-htlc-evm.js
 */

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Configuration - using Polygon RPC
const POLYGON_RPC = process.env.POLYGON_RPC || 'https://1rpc.io/matic';
const CHAIN_NAME = 'Polygon';

// Axelar Polygon Mainnet addresses
const AXELAR_GATEWAY = '0x6f015F16De9fC8791b234eF68D486d2bF203FBA8';
const AXELAR_GAS_SERVICE = '0x2d5d7d31F671F86C782533cc367F14109a082712';

async function main() {
    console.log('='.repeat(60));
    console.log('HTLC Bridge Deployment - Polygon Mainnet');
    console.log('='.repeat(60));

    // Setup provider and wallet with explicit network config
    const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC, {
        name: 'polygon',
        chainId: 137
    });
    const privateKey = process.env.PRIVATE_KEY || process.env.EVM_PRIVATE_KEY;
    
    if (!privateKey) {
        throw new Error('PRIVATE_KEY or EVM_PRIVATE_KEY not found in .env');
    }
    
    const wallet = new ethers.Wallet(privateKey, provider);
    console.log(`\nDeployer: ${wallet.address}`);
    
    const balance = await wallet.getBalance();
    console.log(`Balance: ${ethers.utils.formatEther(balance)} MATIC`);
    
    if (balance.lt(ethers.utils.parseEther('0.1'))) {
        throw new Error('Insufficient MATIC balance for deployment');
    }

    // Get gas price - use EIP-1559 if available
    const feeData = await provider.getFeeData();
    console.log('Fee data:', {
        gasPrice: feeData.gasPrice ? ethers.utils.formatUnits(feeData.gasPrice, 'gwei') + ' gwei' : 'N/A',
        maxFeePerGas: feeData.maxFeePerGas ? ethers.utils.formatUnits(feeData.maxFeePerGas, 'gwei') + ' gwei' : 'N/A',
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ? ethers.utils.formatUnits(feeData.maxPriorityFeePerGas, 'gwei') + ' gwei' : 'N/A',
    });
    
    // Use reasonable gas settings for Polygon
    const maxFeePerGas = ethers.utils.parseUnits('200', 'gwei');
    const maxPriorityFeePerGas = ethers.utils.parseUnits('50', 'gwei');
    console.log(`Using maxFeePerGas: 200 gwei, maxPriorityFeePerGas: 50 gwei`);

    // Load artifacts
    const token1155Artifact = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'artifacts/evm-contracts/IndicatorToken1155.sol/IndicatorToken1155.json')
    ));
    
    const bridgeHTLCArtifact = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'artifacts/evm-contracts/BridgeHTLC.sol/BridgeHTLC.json')
    ));

    // Deploy IndicatorToken1155
    console.log('\n--- Deploying IndicatorToken1155 ---');
    const Token1155Factory = new ethers.ContractFactory(
        token1155Artifact.abi,
        token1155Artifact.bytecode,
        wallet
    );
    
    const token1155 = await Token1155Factory.deploy(
        'https://bridge.example.com/metadata/{id}.json', // URI template
        { maxFeePerGas, maxPriorityFeePerGas, gasLimit: 3000000 }
    );
    
    console.log(`Transaction: ${token1155.deployTransaction.hash}`);
    await token1155.deployed();
    console.log(`IndicatorToken1155 deployed: ${token1155.address}`);

    // Deploy BridgeHTLC
    console.log('\n--- Deploying BridgeHTLC ---');
    const BridgeHTLCFactory = new ethers.ContractFactory(
        bridgeHTLCArtifact.abi,
        bridgeHTLCArtifact.bytecode,
        wallet
    );
    
    const bridgeHTLC = await BridgeHTLCFactory.deploy(
        AXELAR_GATEWAY,
        AXELAR_GAS_SERVICE,
        token1155.address,
        CHAIN_NAME,
        { maxFeePerGas, maxPriorityFeePerGas, gasLimit: 3500000 }
    );
    
    console.log(`Transaction: ${bridgeHTLC.deployTransaction.hash}`);
    await bridgeHTLC.deployed();
    console.log(`BridgeHTLC deployed: ${bridgeHTLC.address}`);

    // Set bridge on token contract
    console.log('\n--- Setting Bridge on Token ---');
    const setBridgeTx = await token1155.setBridge(bridgeHTLC.address, { maxFeePerGas, maxPriorityFeePerGas });
    await setBridgeTx.wait();
    console.log(`Bridge set: ${setBridgeTx.hash}`);

    // Create a test token class
    console.log('\n--- Creating Test Token Class ---');
    const profileHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('test_indicator_profile_v1'));
    const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('test_indicator_data_v1'));
    
    const createClassTx = await token1155.createTokenClass(
        'CO2_REMOVAL',      // indicatorType
        'kgCO2e',           // unit
        'METHODOLOGY_001',  // methodologyId
        profileHash,
        dataHash,
        { maxFeePerGas, maxPriorityFeePerGas }
    );
    await createClassTx.wait();
    console.log(`Token class created: ${createClassTx.hash}`);
    
    // Get the created token ID
    const tokenId = await token1155.nextTokenId() - 1;
    const indicatorId = await token1155.getIndicatorId(tokenId);
    console.log(`Token ID: ${tokenId}`);
    console.log(`Indicator ID: ${indicatorId}`);

    // Mint some tokens for testing
    console.log('\n--- Minting Test Tokens ---');
    const mintAmount = ethers.utils.parseEther('100'); // 100 tokens
    const mintTx = await token1155.mint(wallet.address, tokenId, mintAmount, { maxFeePerGas, maxPriorityFeePerGas });
    await mintTx.wait();
    console.log(`Minted ${ethers.utils.formatEther(mintAmount)} tokens to ${wallet.address}`);

    // Save deployment info
    const deployment = {
        network: 'polygon-mainnet',
        chainId: 137,
        deployer: wallet.address,
        timestamp: new Date().toISOString(),
        contracts: {
            IndicatorToken1155: token1155.address,
            BridgeHTLC: bridgeHTLC.address,
        },
        testTokenClass: {
            tokenId: tokenId.toString(),
            indicatorId: indicatorId,
            indicatorType: 'CO2_REMOVAL',
            unit: 'kgCO2e',
        },
        axelar: {
            gateway: AXELAR_GATEWAY,
            gasService: AXELAR_GAS_SERVICE,
        }
    };

    fs.writeFileSync(
        path.join(__dirname, 'htlc-deployment-evm.json'),
        JSON.stringify(deployment, null, 2)
    );
    console.log('\n--- Deployment saved to htlc-deployment-evm.json ---');

    console.log('\n' + '='.repeat(60));
    console.log('DEPLOYMENT COMPLETE');
    console.log('='.repeat(60));
    console.log(`IndicatorToken1155: ${token1155.address}`);
    console.log(`BridgeHTLC: ${bridgeHTLC.address}`);
    console.log(`Test Token ID: ${tokenId}`);
    console.log('='.repeat(60));
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('Deployment failed:', error);
        process.exit(1);
    });
