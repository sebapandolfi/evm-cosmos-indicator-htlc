#!/usr/bin/env node
/**
 * Reverse-direction end-to-end test: Neutron (source) -> Polygon (destination).
 *
 * Flow:
 *   1. lock_for_burn on the Neutron contract (escrows tokens + bounty,
 *      emits ABI prepare message to Polygon via Axelar GMP)
 *   2. Poll Polygon BridgeHTLC.pendingMints until the prepare arrives
 *   3. claimMint(H, S) on Polygon (mints, emits claim_burn callback to Neutron)
 *   4. Poll the Neutron outbound lock until state == "claimed"
 *      (fallback: submit claim_burn manually with --manual-burn)
 *
 * Usage:
 *   node htlc-reverse-test.js run              # full happy path
 *   node htlc-reverse-test.js run --manual-burn  # step 4 via manual claim_burn
 *   node htlc-reverse-test.js refund <hashlock>  # refund_burn after timeout
 *
 * Env: EVM_PRIVATE_KEY, COSMOS_MNEMONIC, REVERSE_BOUNTY_UNTRN (default 100000),
 *      REVERSE_FEE_UNTRN (default 500000 = 0.5 NTRN relay fee)
 *
 * Results are appended to scripts/reverse-results.json for later analysis.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { ethers } = require('ethers');
const crypto = require('crypto');
const fs = require('fs');
const { getGasSettings, getPolygonProvider } = require('./gas-config');

const CONFIG = {
    polygon: {
        token1155: process.env.POLYGON_TOKEN1155 || '0x7Dbf7583c758e34D2CB4F3fd1E8C998E5469345a',
        bridge: process.env.POLYGON_BRIDGE || '0x078154e912A94f57be962A7B3926dbcaF0eD27e0',
        chainName: process.env.POLYGON_CHAIN_NAME || 'Polygon',
    },
    neutron: {
        contract: process.env.NEUTRON_BRIDGE_CONTRACT || 'neutron1d9k5ceh44555gxru06zk56cm8wd0hf683y77xncq9kmlzmaaxjyqgew60j',
        rpc: process.env.NEUTRON_RPC || 'https://rpc-kralum.neutron-1.neutron.org',
    },
    resultsFile: path.join(__dirname, 'reverse-results.json'),
    pollIntervalMs: 15000,
    maxWaitMs: 15 * 60 * 1000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadEvm() {
    const provider = getPolygonProvider();
    const wallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY, provider);
    const bridgeAbi = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'artifacts/evm-contracts/BridgeHTLC.sol/BridgeHTLC.json'))).abi;
    const tokenAbi = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'artifacts/evm-contracts/IndicatorToken1155.sol/IndicatorToken1155.json'))).abi;
    return {
        wallet,
        bridge: new ethers.Contract(CONFIG.polygon.bridge, bridgeAbi, wallet),
        token: new ethers.Contract(CONFIG.polygon.token1155, tokenAbi, wallet),
    };
}

async function loadCosmos() {
    const { SigningCosmWasmClient } = require('@cosmjs/cosmwasm-stargate');
    const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
    const { GasPrice } = require('@cosmjs/stargate');
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(process.env.COSMOS_MNEMONIC, { prefix: 'neutron' });
    const [account] = await wallet.getAccounts();
    const client = await SigningCosmWasmClient.connectWithSigner(
        CONFIG.neutron.rpc, wallet, { gasPrice: GasPrice.fromString('0.025untrn') });
    return { client, account };
}

function saveResult(entry) {
    let all = [];
    if (fs.existsSync(CONFIG.resultsFile)) all = JSON.parse(fs.readFileSync(CONFIG.resultsFile, 'utf8'));
    all.push(entry);
    fs.writeFileSync(CONFIG.resultsFile, JSON.stringify(all, null, 2));
}

async function run({ manualBurn = false } = {}) {
    const { client, account } = await loadCosmos();
    const { wallet, bridge, token } = await loadEvm();

    const secret = '0x' + crypto.randomBytes(32).toString('hex');
    const hashlock = ethers.utils.keccak256(secret);
    const timelock = Math.floor(Date.now() / 1000) + 2 * 3600; // T_e = 2 h
    const bountyAmt = process.env.REVERSE_BOUNTY_UNTRN || '100000';
    // untrn: bounty + Neutron's mandatory IBC ack+timeout fees (0.4 NTRN)
    const feeAmt = process.env.REVERSE_FEE_UNTRN || '450000';
    // AXL (Axelar-registered asset): relayer fee paying for Polygon execution
    const AXL_DENOM = process.env.AXL_DENOM
        || 'ibc/C0E66D1C81D8AAF0E6896E05190FDFBC222367148F86AC3EA679C28327A763CD';
    const relayFeeAxl = process.env.REVERSE_FEE_UAXL || '2000000'; // 2 AXL
    const totalUntrn = (BigInt(bountyAmt) + BigInt(feeAmt)).toString();

    const result = { direction: 'neutron->polygon', hashlock, timelock, startedAt: new Date().toISOString(), legs: {} };

    // ---- 1. lock_for_burn on Neutron ----
    console.log(`\n[1/4] lock_for_burn on Neutron (hashlock ${hashlock.slice(0, 18)}…)`);
    const t0 = Date.now();
    const funds = [
        { denom: AXL_DENOM, amount: relayFeeAxl },
        { denom: 'untrn', amount: totalUntrn },
    ].sort((a, b) => a.denom.localeCompare(b.denom));
    const lockRes = await client.execute(account.address, CONFIG.neutron.contract, {
        lock_for_burn: {
            token_id: '1',
            amount: '1',
            hashlock,
            timelock,
            evm_recipient: wallet.address,
            destination_chain: CONFIG.polygon.chainName,
            destination_address: CONFIG.polygon.bridge,
            bounty: { denom: 'untrn', amount: bountyAmt },
        },
    }, 'auto', undefined, funds);
    console.log(`  tx: ${lockRes.transactionHash}, gas: ${lockRes.gasUsed}`);
    result.legs.lock = { txHash: lockRes.transactionHash, gasUsed: Number(lockRes.gasUsed), at: new Date().toISOString() };

    // ---- 2. wait for prepare on Polygon ----
    console.log('[2/4] Waiting for prepare-mint on Polygon (poll 15 s)…');
    let pm;
    const t1 = Date.now();
    while (Date.now() - t1 < CONFIG.maxWaitMs) {
        pm = await bridge.getPendingMint(hashlock);
        if (pm.state === 1) break; // PENDING
        await sleep(CONFIG.pollIntervalMs);
    }
    if (!pm || pm.state !== 1) throw new Error('Prepare message never arrived on Polygon');
    const forwardLatency = Math.round((Date.now() - t0) / 1000);
    console.log(`  ✓ pending mint on Polygon after ${forwardLatency}s (amount ${pm.amount}, T_c ${pm.timeout})`);
    result.legs.forwardRelaySeconds = forwardLatency;

    // ---- 3. claimMint on Polygon ----
    console.log('[3/4] claimMint on Polygon…');
    const balBefore = await token.balanceOf(wallet.address, 1);
    const claimTx = await bridge.claimMint(hashlock, secret, {
        ...getGasSettings('claimBurn'),
        value: ethers.utils.parseEther(process.env.REVERSE_CALLBACK_GAS_POL || '0.5'),
    });
    const claimRcpt = await claimTx.wait();
    const balAfter = await token.balanceOf(wallet.address, 1);
    console.log(`  tx: ${claimTx.hash}, gas: ${claimRcpt.gasUsed}, minted: ${balAfter.sub(balBefore)}`);
    result.legs.claim = { txHash: claimTx.hash, gasUsed: claimRcpt.gasUsed.toNumber(), at: new Date().toISOString() };
    const tClaim = Date.now();

    // ---- 4. burn on Neutron (automatic callback, or manual fallback) ----
    if (manualBurn) {
        console.log('[4/4] Manual claim_burn on Neutron (bounty demo)…');
        const burnRes = await client.execute(account.address, CONFIG.neutron.contract,
            { claim_burn: { hashlock, secret } }, 'auto');
        console.log(`  tx: ${burnRes.transactionHash} (bounty paid to caller)`);
        result.legs.burn = { txHash: burnRes.transactionHash, mode: 'manual-fallback', at: new Date().toISOString() };
    } else {
        console.log('[4/4] Waiting for automatic claim_burn callback on Neutron…');
        let lock;
        while (Date.now() - tClaim < CONFIG.maxWaitMs) {
            const q = await client.queryContractSmart(CONFIG.neutron.contract, { outbound_lock: { hashlock } });
            lock = q.lock;
            if (lock && lock.state === 'claimed') break;
            await sleep(CONFIG.pollIntervalMs);
        }
        if (!lock || lock.state !== 'claimed') {
            console.warn('  ! Callback not observed within the window. Submit the fallback:');
            console.warn(`    node htlc-reverse-test.js manual-burn ${hashlock} ${secret}`);
            result.legs.burn = { mode: 'callback-pending' };
        } else {
            const cbLatency = Math.round((Date.now() - tClaim) / 1000);
            console.log(`  ✓ escrow burned via callback after ${cbLatency}s`);
            result.legs.callbackRelaySeconds = cbLatency;
            result.legs.burn = { mode: 'automatic-callback' };
        }
    }

    result.endToEndSeconds = Math.round((Date.now() - t0) / 1000);
    result.completedAt = new Date().toISOString();
    saveResult(result);
    console.log(`\nDone in ${result.endToEndSeconds}s. Result appended to reverse-results.json`);
}

async function manualBurnCmd(hashlock, secret) {
    const { client, account } = await loadCosmos();
    const res = await client.execute(account.address, CONFIG.neutron.contract,
        { claim_burn: { hashlock, secret } }, 'auto');
    console.log(`claim_burn tx: ${res.transactionHash}`);
}

async function refundCmd(hashlock) {
    const { client, account } = await loadCosmos();
    const res = await client.execute(account.address, CONFIG.neutron.contract,
        { refund_burn: { hashlock } }, 'auto');
    console.log(`refund_burn tx: ${res.transactionHash}`);
}

const [cmd, a1, a2] = process.argv.slice(2);
(async () => {
    if (cmd === 'run') await run({ manualBurn: process.argv.includes('--manual-burn') });
    else if (cmd === 'manual-burn') await manualBurnCmd(a1, a2);
    else if (cmd === 'refund') await refundCmd(a1);
    else console.log('Usage: node htlc-reverse-test.js run [--manual-burn] | manual-burn <hashlock> <secret> | refund <hashlock>');
})().catch((e) => { console.error(e); process.exit(1); });
