#!/usr/bin/env node
/**
 * Bounty-recovery demo (failure mode b/c): stalled callback + rational monitor.
 *
 * Demonstrates on mainnet that when the automatic callback does not execute
 * the source burn, an independent third party (the "monitor", a different
 * key) profitably finalises it via claimBurn and collects the escrowed
 * bounty. This is the experiment backing the incentive-compatibility claim
 * (assumption A4) in the paper.
 *
 * Flow:
 *   1. USER key: lockForBurn on Polygon with bounty (BOUNTY_POL, default 0.1)
 *   2. Wait for the prepare to arrive on Neutron
 *   3. USER key: claim_mint on Neutron WITHOUT callback funds
 *      -> the secret is now public on Neutron; no on-chain callback was sent
 *   4. MONITOR key (MONITOR_PRIVATE_KEY, a distinct funded account): reads the
 *      revealed secret from the Neutron contract and submits claimBurn on
 *      Polygon, collecting the bounty. Reports time-to-recovery and the
 *      monitor's net gain.
 *
 * Usage: node scripts/bounty-demo.js
 * Env:   EVM_PRIVATE_KEY, MONITOR_PRIVATE_KEY, COSMOS_MNEMONIC, BOUNTY_POL
 *
 * Results appended to scripts/bounty-demo-results.json (tx hashes for the paper).
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
    },
    neutron: {
        contract: process.env.NEUTRON_BRIDGE_CONTRACT || 'neutron1d9k5ceh44555gxru06zk56cm8wd0hf683y77xncq9kmlzmaaxjyqgew60j',
        rpc: process.env.NEUTRON_RPC || 'https://rpc-kralum.neutron-1.neutron.org',
    },
    resultsFile: path.join(__dirname, 'bounty-demo-results.json'),
    pollIntervalMs: 15000,
    maxWaitMs: 15 * 60 * 1000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    if (!process.env.MONITOR_PRIVATE_KEY) {
        console.error('Set MONITOR_PRIVATE_KEY (a distinct funded Polygon key) in .env');
        process.exit(1);
    }

    const provider = getPolygonProvider();
    const user = new ethers.Wallet(process.env.EVM_PRIVATE_KEY, provider);
    const monitor = new ethers.Wallet(process.env.MONITOR_PRIVATE_KEY, provider);
    const bridgeAbi = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'artifacts/evm-contracts/BridgeHTLC.sol/BridgeHTLC.json'))).abi;
    const bridgeUser = new ethers.Contract(CONFIG.polygon.bridge, bridgeAbi, user);
    const bridgeMonitor = bridgeUser.connect(monitor);

    const { SigningCosmWasmClient } = require('@cosmjs/cosmwasm-stargate');
    const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
    const { GasPrice } = require('@cosmjs/stargate');
    const cwWallet = await DirectSecp256k1HdWallet.fromMnemonic(process.env.COSMOS_MNEMONIC, { prefix: 'neutron' });
    const [cwAccount] = await cwWallet.getAccounts();
    const cosmos = await SigningCosmWasmClient.connectWithSigner(
        CONFIG.neutron.rpc, cwWallet, { gasPrice: GasPrice.fromString('0.025untrn') });

    const secret = '0x' + crypto.randomBytes(32).toString('hex');
    const hashlock = ethers.utils.keccak256(secret);
    const bounty = ethers.utils.parseEther(process.env.BOUNTY_POL || '0.1');
    const timelock = Math.floor(Date.now() / 1000) + 2 * 3600;
    const result = { hashlock, bounty: ethers.utils.formatEther(bounty), startedAt: new Date().toISOString() };

    // 1. Lock with bounty
    console.log(`[1/4] lockForBurn with bounty ${ethers.utils.formatEther(bounty)} POL…`);
    const lockTx = await bridgeUser.lockForBurn(
        1, ethers.utils.parseEther('1'), hashlock, timelock,
        cwAccount.address, 'neutron', CONFIG.neutron.contract, bounty,
        { ...getGasSettings('lockForBurn'), value: ethers.utils.parseEther('1') }
    );
    await lockTx.wait();
    console.log(`  tx: ${lockTx.hash}`);
    result.lockTx = lockTx.hash;

    // 2. Wait for prepare on Neutron
    console.log('[2/4] Waiting for prepare on Neutron…');
    const t0 = Date.now();
    for (;;) {
        if (Date.now() - t0 > CONFIG.maxWaitMs) throw new Error('Prepare never arrived');
        try {
            const q = await cosmos.queryContractSmart(CONFIG.neutron.contract, { h_t_l_c_lock: { hashlock } });
            if (q.lock) break;
        } catch (_) { /* not yet */ }
        await sleep(CONFIG.pollIntervalMs);
    }
    console.log('  ✓ pending mint on Neutron');

    // 3. Claim on Neutron WITHOUT callback funds (stalls the automatic callback)
    console.log('[3/4] claim_mint on Neutron without callback funds (secret becomes public)…');
    const claimRes = await cosmos.execute(cwAccount.address, CONFIG.neutron.contract,
        { claim_mint: { hashlock, secret } }, 'auto');
    console.log(`  tx: ${claimRes.transactionHash}`);
    result.claimTx = claimRes.transactionHash;
    const tClaim = Date.now();

    // 4. Monitor reads the (now public) secret from chain state and claims the bounty
    console.log('[4/4] MONITOR reads secret from Neutron and submits claimBurn on Polygon…');
    const q = await cosmos.queryContractSmart(CONFIG.neutron.contract, { h_t_l_c_lock: { hashlock } });
    const publicSecret = q.lock.secret; // read from chain, as a real monitor would
    if (!publicSecret) throw new Error('Secret not readable on Neutron');

    const balBefore = await monitor.getBalance();
    const burnTx = await bridgeMonitor.claimBurn(hashlock, publicSecret, getGasSettings('claimBurn'));
    const rcpt = await burnTx.wait();
    const gasCost = rcpt.gasUsed.mul(rcpt.effectiveGasPrice);
    const balAfter = await monitor.getBalance();
    const netGain = balAfter.sub(balBefore); // includes -gas +bounty

    const recoverySeconds = Math.round((Date.now() - tClaim) / 1000);
    console.log(`  tx: ${burnTx.hash}`);
    console.log(`  time-to-recovery after claim: ${recoverySeconds}s`);
    console.log(`  monitor net gain: ${ethers.utils.formatEther(netGain)} POL (gas ${ethers.utils.formatEther(gasCost)} POL)`);

    result.burnTx = burnTx.hash;
    result.recoverySeconds = recoverySeconds;
    result.monitorNetGainPOL = ethers.utils.formatEther(netGain);
    result.monitorGasPOL = ethers.utils.formatEther(gasCost);
    result.completedAt = new Date().toISOString();

    let all = [];
    if (fs.existsSync(CONFIG.resultsFile)) all = JSON.parse(fs.readFileSync(CONFIG.resultsFile, 'utf8'));
    all.push(result);
    fs.writeFileSync(CONFIG.resultsFile, JSON.stringify(all, null, 2));
    console.log('\nDone. Result appended to bounty-demo-results.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
