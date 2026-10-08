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

// Configuration - candidate RPCs, tried in order until one responds.
// NEUTRON_RPC (if set in .env) is always tried first.
const RPC_CANDIDATES = [
    process.env.NEUTRON_RPC,
    'https://rpc-lb.neutron.org',
    'https://neutron-rpc.publicnode.com',
    'https://neutron-rpc.polkachu.com',
    'https://rpc.neutron.nodestake.top',
    'https://rpc-kralum.neutron-1.neutron.org',
].filter(Boolean);
const CHAIN_ID = 'neutron-1';

async function connectSigner(wallet, gasPrice) {
    for (const url of RPC_CANDIDATES) {
        try {
            const client = await Promise.race([
                SigningCosmWasmClient.connectWithSigner(url, wallet, { gasPrice }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
            ]);
            console.log(`RPC: ${url}`);
            return client;
        } catch (e) {
            console.warn(`RPC unavailable (${(e.message || '').slice(0, 50)}): ${url}`);
        }
    }
    throw new Error('No Neutron RPC reachable; set NEUTRON_RPC to a working endpoint (see https://github.com/cosmos/chain-registry/blob/master/neutron/chain.json)');
}

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

    // Connect to Neutron (first reachable RPC)
    const gasPrice = GasPrice.fromString('0.025untrn');
    const client = await connectSigner(wallet, gasPrice);

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

    // Upload contract (or reuse an existing code ID: CODE_ID=5347 skips upload)
    let codeId;
    if (process.env.CODE_ID) {
        codeId = parseInt(process.env.CODE_ID, 10);
        console.log(`\n--- Reusing Code ID ${codeId} (upload skipped) ---`);
    } else {
        console.log('\n--- Uploading Contract ---');
        const uploadResult = await client.upload(
            account.address,
            wasmCode,
            'auto',
            'HTLC Bridge Receiver'
        );
        codeId = uploadResult.codeId;
        console.log(`Code ID: ${codeId}`);
        console.log(`Transaction: ${uploadResult.transactionHash}`);
    }

    // Instantiate contract
    console.log('\n--- Instantiating Contract ---');
    const instantiateMsg = {
        // Neutron's IBC transfer channel with Axelar (axelarnet). Verified on
        // mainnet: inbound GMP packets arrive on neutron channel-2 (axelar
        // side channel-78); outbound must use the same pair. channel-18 was
        // wrong and is kept out deliberately.
        channel: process.env.NEUTRON_AXELAR_CHANNEL || 'channel-2',
        token_name: 'Bridged Indicator Token',
        token_symbol: 'bIND',
        decimals: 18,
        axelar_gateway: null,
        // Axelar GMP account: receiver of IBC transfers carrying GMP memos.
        // Required for on-chain outbound GMP (automatic callback + reverse
        // direction). VERIFY the current address against the Axelar docs
        // (https://docs.axelar.dev -> GMP from Cosmos) before deploying.
        axelar_gmp_account: process.env.AXELAR_GMP_ACCOUNT || null,
        // Axelar relayer fee recipient: REQUIRED for automatic execution of
        // Cosmos->EVM messages (callback / reverse direction). Source:
        // evm-cosmos-gmp-sample/native-integration README (mainnet address).
        axelar_fee_recipient: process.env.AXELAR_FEE_RECIPIENT
            || 'axelar1aythygn6z5thymj6tmzfwekzh05ewg3l7d6y89',
        // Protocol-minimum bounty (untrn) for reverse-direction locks
        min_bounty: process.env.MIN_BOUNTY_UNTRN || '50000',
    };

    const instantiateResult = await client.instantiate(
        account.address,
        codeId,
        instantiateMsg,
        'HTLC Bridge Receiver',
        'auto',
        { admin: account.address }
    );
    
    console.log(`Contract: ${instantiateResult.contractAddress}`);
    console.log(`Transaction: ${instantiateResult.transactionHash}`);

    // Create a test token class
    console.log('\n--- Creating Test Token Class ---');
    // Mirror the EVM registration EXACTLY (deploy-htlc-evm.js): same profile
    // and data hashes, indicator_id = keccak256(profile_hash). The mirrored
    // registries must agree or prepare_mint rejects with IndicatorMismatch.
    const { ethers } = require('ethers');
    const profileHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('test_indicator_profile_v1'));
    const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('test_indicator_data_v1'));
    const indicatorId = ethers.utils.keccak256(profileHash);
    console.log(`Mirrored indicator_id: ${indicatorId}`);
    const createClassMsg = {
        create_token_class: {
            token_id: '1',
            indicator_id: indicatorId,
            indicator_type: 'CO2_REMOVAL',
            unit: 'kgCO2e',
            methodology_id: 'METHODOLOGY_001', // mirror of the EVM registration
            profile_hash: profileHash,
            data_hash: dataHash,
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
        codeId: codeId,
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
    console.log(`Code ID: ${codeId}`);
    console.log(`Contract: ${instantiateResult.contractAddress}`);
    console.log('='.repeat(60));
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('Deployment failed:', error);
        process.exit(1);
    });
