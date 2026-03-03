#!/usr/bin/env node
/**
 * Quick HTLC Test - Uses aggressive gas for instant transactions
 * 
 * Usage:
 *   node htlc-quick-test.js lock        # Lock tokens on Polygon
 *   node htlc-quick-test.js claim-cosmos # Claim on Neutron
 *   node htlc-quick-test.js claim-evm   # Finalize burn on Polygon
 *   node htlc-quick-test.js status      # Check status
 */

require('dotenv').config();
const { ethers } = require('ethers');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getGasSettings, getPolygonProvider, formatGasInfo } = require('./gas-config');

// Contract addresses (deployed on mainnet)
const CONFIG = {
    polygon: {
        token1155: '0xeDD6b12bFAC489Bc18Cdda2eE73988420C79dDfF',
        bridge: '0xB3ac9Ef1872c5be924dbB05a92e0150B601831Aa',
    },
    neutron: {
        contract: 'neutron12ccw58xsmyukfya6nm4j3k5588kajaj9za6cfxwxng3uf9xqrfusgmf4kz',
        rpc: 'https://rpc-kralum.neutron-1.neutron.org',
    },
    stateFile: path.join(__dirname, 'htlc-state.json'),
};

async function loadContracts() {
    const provider = getPolygonProvider();
    const wallet = new ethers.Wallet(
        process.env.PRIVATE_KEY || process.env.EVM_PRIVATE_KEY,
        provider
    );

    const bridgeAbi = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'artifacts/evm-contracts/BridgeHTLC.sol/BridgeHTLC.json')
    )).abi;

    const tokenAbi = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'artifacts/evm-contracts/IndicatorToken1155.sol/IndicatorToken1155.json')
    )).abi;

    return {
        provider,
        wallet,
        bridge: new ethers.Contract(CONFIG.polygon.bridge, bridgeAbi, wallet),
        token: new ethers.Contract(CONFIG.polygon.token1155, tokenAbi, wallet),
    };
}

async function lockTokens(amount = '10', recipient = 'neutron1n4ywn62cl3p6uzj0l8a66s3xsj7gg9qv78s8g7') {
    console.log('\n🔒 LOCKING TOKENS ON POLYGON\n');
    
    const { wallet, bridge, token } = await loadContracts();
    const gasSettings = getGasSettings('lockForBurn');
    
    console.log('Gas settings:', formatGasInfo(gasSettings));
    console.log('Wallet:', wallet.address);
    console.log('Balance:', ethers.utils.formatEther(await wallet.getBalance()), 'MATIC\n');

    // Generate secret
    const secret = '0x' + crypto.randomBytes(32).toString('hex');
    const hashlock = ethers.utils.keccak256(secret);
    const timelock = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    const tokenId = 1;
    const lockAmount = ethers.utils.parseEther(amount);

    console.log('Secret:', secret);
    console.log('Hashlock:', hashlock);
    console.log('Amount:', amount, 'tokens');
    console.log('Recipient:', recipient);

    // Check approval
    const isApproved = await token.isApprovedForAll(wallet.address, CONFIG.polygon.bridge);
    if (!isApproved) {
        console.log('\nApproving bridge...');
        const approveTx = await token.setApprovalForAll(CONFIG.polygon.bridge, true, getGasSettings('approve'));
        await approveTx.wait();
        console.log('✓ Approved');
    }

    // Lock tokens
    console.log('\nLocking tokens...');
    const lockTx = await bridge.lockForBurn(
        tokenId,
        lockAmount,
        hashlock,
        timelock,
        recipient,
        'neutron',
        CONFIG.neutron.contract,
        {
            ...gasSettings,
            value: ethers.utils.parseEther('1'), // GMP gas
        }
    );

    console.log('TX:', lockTx.hash);
    const receipt = await lockTx.wait();
    console.log('✓ Locked in block', receipt.blockNumber, '| Gas:', receipt.gasUsed.toString());

    // Save state
    const state = {
        secret,
        hashlock,
        tokenId,
        amount,
        cosmosRecipient: recipient,
        timelock,
        evmTxHash: lockTx.hash,
        status: 'locked',
    };
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));

    console.log('\n✓ State saved to htlc-state.json');
    console.log('📡 Axelarscan: https://axelarscan.io/gmp/' + lockTx.hash);
    console.log('\nNext: Wait for GMP (~10-20 min), then run: node htlc-quick-test.js claim-cosmos');
}

async function claimOnCosmos() {
    console.log('\n🌐 CLAIMING ON NEUTRON\n');

    const { SigningCosmWasmClient } = require('@cosmjs/cosmwasm-stargate');
    const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
    const { GasPrice } = require('@cosmjs/stargate');

    const state = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
    console.log('Hashlock:', state.hashlock);
    console.log('Secret:', state.secret);

    const mnemonic = process.env.COSMOS_MNEMONIC;
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: 'neutron' });
    const [account] = await wallet.getAccounts();

    const client = await SigningCosmWasmClient.connectWithSigner(
        CONFIG.neutron.rpc,
        wallet,
        { gasPrice: GasPrice.fromString('0.025untrn') }
    );

    console.log('Claiming as:', account.address);

    // Check if HTLC exists
    try {
        const htlc = await client.queryContractSmart(CONFIG.neutron.contract, {
            h_t_l_c_lock: { hashlock: state.hashlock }
        });
        console.log('HTLC state:', htlc.lock.state);
        
        if (htlc.lock.state !== 'pending') {
            console.log('HTLC is not pending, cannot claim');
            return;
        }
    } catch (e) {
        console.log('HTLC not found yet - GMP still processing');
        console.log('Check: https://axelarscan.io/gmp/' + state.evmTxHash);
        return;
    }

    // Claim
    console.log('\nExecuting claim_mint...');
    const result = await client.execute(
        account.address,
        CONFIG.neutron.contract,
        { claim_mint: { hashlock: state.hashlock, secret: state.secret } },
        'auto'
    );

    console.log('✓ Claimed! TX:', result.transactionHash);

    // Update state
    state.status = 'claimed_cosmos';
    state.cosmosClaimTx = result.transactionHash;
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));

    console.log('\nNext: node htlc-quick-test.js claim-evm');
}

async function claimOnEVM() {
    console.log('\n🔥 FINALIZING BURN ON POLYGON\n');

    const state = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
    const { wallet, bridge, token } = await loadContracts();
    const gasSettings = getGasSettings('claimBurn');

    console.log('Gas settings:', formatGasInfo(gasSettings));
    console.log('Hashlock:', state.hashlock);

    // Check lock state
    const lock = await bridge.getLock(state.hashlock);
    const stateNames = ['EMPTY', 'LOCKED', 'CLAIMED', 'REFUNDED'];
    console.log('Lock state:', stateNames[lock.state]);

    if (lock.state !== 1) {
        console.log('Lock is not LOCKED, cannot claim');
        return;
    }

    // Claim
    console.log('\nCalling claimBurn...');
    const claimTx = await bridge.claimBurn(state.hashlock, state.secret, gasSettings);
    console.log('TX:', claimTx.hash);
    
    const receipt = await claimTx.wait();
    console.log('✓ Burned in block', receipt.blockNumber, '| Gas:', receipt.gasUsed.toString());

    // Verify
    const bridgeBalance = await token.balanceOf(CONFIG.polygon.bridge, 1);
    console.log('Bridge balance:', ethers.utils.formatEther(bridgeBalance));

    // Update state
    state.status = 'completed';
    state.evmClaimTx = claimTx.hash;
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));

    console.log('\n✅ HTLC TRANSFER COMPLETE!');
}

async function checkStatus() {
    console.log('\n📊 HTLC STATUS\n');

    // Check state file
    if (fs.existsSync(CONFIG.stateFile)) {
        const state = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
        console.log('Local state:', JSON.stringify(state, null, 2));
    } else {
        console.log('No htlc-state.json found');
        return;
    }

    const state = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));

    // Check EVM
    const { bridge, token } = await loadContracts();
    const lock = await bridge.getLock(state.hashlock);
    console.log('\n--- Polygon ---');
    console.log('State:', ['EMPTY', 'LOCKED', 'CLAIMED', 'REFUNDED'][lock.state]);
    console.log('Bridge balance:', ethers.utils.formatEther(await token.balanceOf(CONFIG.polygon.bridge, 1)));

    // Check Cosmos
    try {
        const { SigningCosmWasmClient } = require('@cosmjs/cosmwasm-stargate');
        const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
        
        const mnemonic = process.env.COSMOS_MNEMONIC;
        const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: 'neutron' });
        const client = await SigningCosmWasmClient.connectWithSigner(CONFIG.neutron.rpc, wallet);

        const htlc = await client.queryContractSmart(CONFIG.neutron.contract, {
            h_t_l_c_lock: { hashlock: state.hashlock }
        });
        console.log('\n--- Neutron ---');
        console.log('State:', htlc.lock.state);

        const balance = await client.queryContractSmart(CONFIG.neutron.contract, {
            balance: { address: state.cosmosRecipient, token_id: '1' }
        });
        console.log('Recipient balance:', balance.balance);
    } catch (e) {
        console.log('\n--- Neutron ---');
        console.log('HTLC not found or error:', e.message.slice(0, 100));
    }
}

// Main
const command = process.argv[2] || 'status';

switch (command) {
    case 'lock':
        lockTokens(process.argv[3], process.argv[4]).catch(console.error);
        break;
    case 'claim-cosmos':
        claimOnCosmos().catch(console.error);
        break;
    case 'claim-evm':
        claimOnEVM().catch(console.error);
        break;
    case 'status':
        checkStatus().catch(console.error);
        break;
    default:
        console.log('Usage: node htlc-quick-test.js [lock|claim-cosmos|claim-evm|status]');
}
