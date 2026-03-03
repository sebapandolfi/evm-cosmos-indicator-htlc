/**
 * Deploy HTLC Bridge Receiver contract on Neutron Mainnet
 * 
 * Usage: node deploy-htlc-cosmos.js
 */

require('dotenv').config();
const { SigningCosmWasmClient } = require('@cosmjs/cosmwasm-stargate');
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { GasPrice } = require('@cosmjs/stargate');
const fs = require('fs');
const path = require('path');

// Configuration
const NEUTRON_RPC = 'https://rpc-kralum.neutron-1.neutron.org';
const CHAIN_ID = 'neutron-1';

async function main() {
    console.log('='.repeat(60));
    console.log('HTLC Bridge Receiver Deployment - Neutron Mainnet');
    console.log('='.repeat(60));

    // Get mnemonic
    const mnemonic = process.env.COSMOS_MNEMONIC;
    if (!mnemonic) {
        throw new Error('COSMOS_MNEMONIC not found in .env');
    }

    // Create wallet
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
        prefix: 'neutron',
    });
    
    const [account] = await wallet.getAccounts();
    console.log(`\nDeployer: ${account.address}`);

    // Connect to Neutron
    const gasPrice = GasPrice.fromString('0.025untrn');
    const client = await SigningCosmWasmClient.connectWithSigner(
        NEUTRON_RPC,
        wallet,
        { gasPrice }
    );

    // Check balance
    const balance = await client.getBalance(account.address, 'untrn');
    console.log(`Balance: ${parseInt(balance.amount) / 1e6} NTRN`);

    if (parseInt(balance.amount) < 1000000) {
        throw new Error('Insufficient NTRN balance for deployment');
    }

    // Read WASM file
    const wasmPath = path.join(__dirname, '..', 'cosmwasm-contract/artifacts/token_bridge_receiver.wasm');
    
    if (!fs.existsSync(wasmPath)) {
        console.log('\nWASM file not found. Compiling...');
        console.log('Run: cd ../axelar-examples/examples/cosmos/token-bridge-poc/wasm-contract && docker run --rm -v "$(pwd)":/code --mount type=volume,source="$(basename "$(pwd)")_cache",target=/target --mount type=volume,source=registry_cache,target=/usr/local/cargo/registry cosmwasm/optimizer:0.15.0');
        throw new Error(`WASM file not found at ${wasmPath}`);
    }

    const wasmCode = fs.readFileSync(wasmPath);
    console.log(`\nWASM size: ${wasmCode.length} bytes`);

    // Upload contract
    console.log('\n--- Uploading Contract ---');
    const uploadResult = await client.upload(
        account.address,
        wasmCode,
        'auto',
        'HTLC Bridge Receiver'
    );
    console.log(`Code ID: ${uploadResult.codeId}`);
    console.log(`Transaction: ${uploadResult.transactionHash}`);

    // Instantiate contract
    console.log('\n--- Instantiating Contract ---');
    const instantiateMsg = {
        channel: 'channel-18', // Axelar channel on Neutron
        token_name: 'Bridged Indicator Token',
        token_symbol: 'bIND',
        decimals: 18,
        axelar_gateway: null,
    };

    const instantiateResult = await client.instantiate(
        account.address,
        uploadResult.codeId,
        instantiateMsg,
        'HTLC Bridge Receiver',
        'auto',
        { admin: account.address }
    );
    
    console.log(`Contract: ${instantiateResult.contractAddress}`);
    console.log(`Transaction: ${instantiateResult.transactionHash}`);

    // Create a test token class
    console.log('\n--- Creating Test Token Class ---');
    const createClassMsg = {
        create_token_class: {
            token_id: '1',
            indicator_id: '0x' + Buffer.from('test_indicator_id').toString('hex').padEnd(64, '0'),
            indicator_type: 'CO2_REMOVAL',
            unit: 'kgCO2e',
            methodology_id: 'METHODOLOGY_001',
            profile_hash: '0x' + Buffer.from('test_profile_hash').toString('hex').padEnd(64, '0'),
            data_hash: '0x' + Buffer.from('test_data_hash').toString('hex').padEnd(64, '0'),
        }
    };

    const createClassResult = await client.execute(
        account.address,
        instantiateResult.contractAddress,
        createClassMsg,
        'auto'
    );
    console.log(`Token class created: ${createClassResult.transactionHash}`);

    // Save deployment info
    const deployment = {
        network: 'neutron-mainnet',
        chainId: CHAIN_ID,
        deployer: account.address,
        timestamp: new Date().toISOString(),
        codeId: uploadResult.codeId,
        contract: instantiateResult.contractAddress,
        testTokenClass: {
            tokenId: '1',
            indicatorType: 'CO2_REMOVAL',
            unit: 'kgCO2e',
        }
    };

    fs.writeFileSync(
        path.join(__dirname, 'htlc-deployment-cosmos.json'),
        JSON.stringify(deployment, null, 2)
    );
    console.log('\n--- Deployment saved to htlc-deployment-cosmos.json ---');

    console.log('\n' + '='.repeat(60));
    console.log('DEPLOYMENT COMPLETE');
    console.log('='.repeat(60));
    console.log(`Code ID: ${uploadResult.codeId}`);
    console.log(`Contract: ${instantiateResult.contractAddress}`);
    console.log('='.repeat(60));
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('Deployment failed:', error);
        process.exit(1);
    });
