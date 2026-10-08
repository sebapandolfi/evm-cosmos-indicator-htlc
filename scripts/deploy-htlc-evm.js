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

// Configuration - candidate RPCs, tried in order until one responds.
// POLYGON_RPC (if set) is always tried first.
const RPC_CANDIDATES = [
    process.env.POLYGON_RPC,
    'https://polygon-bor-rpc.publicnode.com',
    'https://polygon-rpc.com',
    'https://1rpc.io/matic',
    'https://polygon.llamarpc.com',
    'https://rpc.ankr.com/polygon',
].filter(Boolean);
const CHAIN_NAME = 'Polygon';

async function connectProvider() {
    for (const url of RPC_CANDIDATES) {
        const provider = new ethers.providers.JsonRpcProvider(url, { name: 'polygon', chainId: 137 });
        try {
            await Promise.race([
                provider.getBlockNumber(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
            ]);
            console.log(`RPC: ${url}`);
            return provider;
        } catch (e) {
            console.warn(`RPC unavailable (${e.message.slice(0, 40)}): ${url}`);
        }
    }
    throw new Error('No Polygon RPC reachable; set POLYGON_RPC to a working endpoint');
}

// Axelar Polygon Mainnet addresses
const AXELAR_GATEWAY = '0x6f015F16De9fC8791b234eF68D486d2bF203FBA8';
const AXELAR_GAS_SERVICE = '0x2d5d7d31F671F86C782533cc367F14109a082712';

async function main() {
    console.log('='.repeat(60));
    console.log('HTLC Bridge Deployment - Polygon Mainnet');
    console.log('='.repeat(60));

    // Setup provider (first reachable RPC) and wallet
    const provider = await connectProvider();
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
    
    // Dynamic gas settings: follow the network suggestion with a 25% buffer
    // so the deployment cannot get stuck below the base fee.
    // Overridable via MAX_FEE_GWEI / PRIORITY_GWEI env vars.
    const suggestedMax = feeData.maxFeePerGas || ethers.utils.parseUnits('300', 'gwei');
    const maxFeePerGas = process.env.MAX_FEE_GWEI
        ? ethers.utils.parseUnits(process.env.MAX_FEE_GWEI, 'gwei')
        : suggestedMax.mul(125).div(100);
    const suggestedPriority = feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('30', 'gwei');
    const minPriority = ethers.utils.parseUnits('30', 'gwei');
    const maxPriorityFeePerGas = process.env.PRIORITY_GWEI
        ? ethers.utils.parseUnits(process.env.PRIORITY_GWEI, 'gwei')
        : (suggestedPriority.gt(minPriority) ? suggestedPriority : minPriority);
    console.log(`Using maxFeePerGas: ${ethers.utils.formatUnits(maxFeePerGas, 'gwei')} gwei, ` +
        `maxPriorityFeePerGas: ${ethers.utils.formatUnits(maxPriorityFeePerGas, 'gwei')} gwei`);

    // Load artifacts
    const token1155Artifact = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'artifacts/evm-contracts/IndicatorToken1155.sol/IndicatorToken1155.json')
    ));
    
    const bridgeHTLCArtifact = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'artifacts/evm-contracts/BridgeHTLC.sol/BridgeHTLC.json')
    ));

    // Estimate deployment gas with a 25% buffer (hardcoded limits caused an
    // out-of-gas revert after the contract grew: bounty + reverse direction).
    async function estimateDeployGas(factory, args, fallback) {
        try {
            const tx = factory.getDeployTransaction(...args);
            const est = await provider.estimateGas({ ...tx, from: wallet.address });
            return est.mul(125).div(100);
        } catch (e) {
            console.warn(`Gas estimation failed (${e.reason || e.message}); using fallback ${fallback}`);
            return ethers.BigNumber.from(fallback);
        }
    }

    // Deploy (or reuse) IndicatorToken1155. Set TOKEN1155_ADDRESS to reuse an
    // already-deployed token contract instead of deploying a new one.
    const Token1155Factory = new ethers.ContractFactory(
        token1155Artifact.abi,
        token1155Artifact.bytecode,
        wallet
    );

    let token1155;
    if (process.env.TOKEN1155_ADDRESS) {
        console.log(`\n--- Reusing IndicatorToken1155 at ${process.env.TOKEN1155_ADDRESS} ---`);
        token1155 = Token1155Factory.attach(process.env.TOKEN1155_ADDRESS);
    } else {
        console.log('\n--- Deploying IndicatorToken1155 ---');
        const tokenArgs = ['https://bridge.example.com/metadata/{id}.json'];
        const tokenGas = await estimateDeployGas(Token1155Factory, tokenArgs, 4000000);
        console.log(`Gas limit: ${tokenGas.toString()}`);
        token1155 = await Token1155Factory.deploy(
            ...tokenArgs,
            { maxFeePerGas, maxPriorityFeePerGas, gasLimit: tokenGas }
        );
        console.log(`Transaction: ${token1155.deployTransaction.hash}`);
        await token1155.deployed();
        console.log(`IndicatorToken1155 deployed: ${token1155.address}`);
    }

    // Deploy BridgeHTLC
    console.log('\n--- Deploying BridgeHTLC ---');
    const BridgeHTLCFactory = new ethers.ContractFactory(
        bridgeHTLCArtifact.abi,
        bridgeHTLCArtifact.bytecode,
        wallet
    );

    const bridgeArgs = [AXELAR_GATEWAY, AXELAR_GAS_SERVICE, token1155.address, CHAIN_NAME];
    const bridgeGas = await estimateDeployGas(BridgeHTLCFactory, bridgeArgs, 7000000);
    console.log(`Gas limit: ${bridgeGas.toString()}`);
    const bridgeHTLC = await BridgeHTLCFactory.deploy(
        ...bridgeArgs,
        { maxFeePerGas, maxPriorityFeePerGas, gasLimit: bridgeGas }
    );

    console.log(`Transaction: ${bridgeHTLC.deployTransaction.hash}`);
    await bridgeHTLC.deployed();
    console.log(`BridgeHTLC deployed: ${bridgeHTLC.address}`);

    // Set bridge on token contract
    console.log('\n--- Setting Bridge on Token ---');
    const setBridgeTx = await token1155.setBridge(bridgeHTLC.address, { maxFeePerGas, maxPriorityFeePerGas });
    await setBridgeTx.wait();
    console.log(`Bridge set: ${setBridgeTx.hash}`);

    // Authorize the Neutron counterpart for reverse-direction prepare-mint
    // messages (set NEUTRON_BRIDGE_CONTRACT after deploying the CosmWasm side,
    // then re-run this block or call setAuthorizedSource manually).
    if (process.env.NEUTRON_BRIDGE_CONTRACT) {
        console.log('\n--- Authorizing Neutron counterpart (reverse direction) ---');
        const setSrcTx = await bridgeHTLC.setAuthorizedSource(
            process.env.NEUTRON_CHAIN_NAME || 'neutron',
            process.env.NEUTRON_BRIDGE_CONTRACT,
            { maxFeePerGas, maxPriorityFeePerGas }
        );
        await setSrcTx.wait();
        console.log(`Authorized source set: ${setSrcTx.hash}`);
    } else {
        console.log('\nNOTE: NEUTRON_BRIDGE_CONTRACT not set; run setAuthorizedSource later to enable the reverse direction.');
    }

    // Create a test token class (skipped when the class already exists on a
    // reused token contract)
    const profileHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('test_indicator_profile_v1'));
    const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('test_indicator_data_v1'));
    const expectedIndicatorId = ethers.utils.keccak256(profileHash);

    let tokenId;
    const existingTokenId = await token1155.getTokenId(expectedIndicatorId);
    if (!existingTokenId.isZero()) {
        tokenId = existingTokenId;
        console.log(`\n--- Token class already registered (tokenId ${tokenId}) — skipping create/mint ---`);
        const bal = await token1155.balanceOf(wallet.address, tokenId);
        console.log(`Existing balance: ${ethers.utils.formatEther(bal)} tokens`);
    } else {
        console.log('\n--- Creating Test Token Class ---');
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

        tokenId = (await token1155.nextTokenId()) - 1;
        console.log(`Token ID: ${tokenId}`);
        console.log(`Indicator ID: ${await token1155.getIndicatorId(tokenId)}`);

        console.log('\n--- Minting Test Tokens ---');
        const mintAmount = ethers.utils.parseEther('100'); // 100 tokens
        // mint() is bridge-only; initial distribution uses the owner-only mintInitialSupply
        const mintTx = await token1155.mintInitialSupply(wallet.address, tokenId, mintAmount, { maxFeePerGas, maxPriorityFeePerGas });
        await mintTx.wait();
        console.log(`Minted ${ethers.utils.formatEther(mintAmount)} tokens to ${wallet.address}`);
    }

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
