#!/usr/bin/env node
/**
 * List (and optionally refund) this wallet's HTLC locks on the Polygon bridge.
 *
 * Usage:
 *   node scripts/refund-locks.js                    # list locks + status
 *   node scripts/refund-locks.js refund             # refund all refundable
 *   node scripts/refund-locks.js refund <hashlock>  # refund one
 *
 * Env: POLYGON_BRIDGE, EVM_PRIVATE_KEY
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { ethers } = require('ethers');
const fs = require('fs');
const { getGasSettings, getPolygonProvider } = require('./gas-config');

const STATES = ['EMPTY', 'LOCKED', 'CLAIMED', 'REFUNDED'];

async function main() {
    const provider = getPolygonProvider();
    const wallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY || process.env.PRIVATE_KEY, provider);
    const abi = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'artifacts/evm-contracts/BridgeHTLC.sol/BridgeHTLC.json'))).abi;
    const bridge = new ethers.Contract(process.env.POLYGON_BRIDGE, abi, wallet);

    const [cmd, onlyHashlock] = process.argv.slice(2);
    const hashlocks = onlyHashlock ? [onlyHashlock] : await bridge.getUserLocks(wallet.address);
    const now = Math.floor(Date.now() / 1000);

    for (const h of hashlocks) {
        const lock = await bridge.getLock(h);
        const refundable = lock.state === 1 && now >= lock.timelock.toNumber();
        const waitMin = lock.state === 1 ? Math.max(0, Math.ceil((lock.timelock.toNumber() - now) / 60)) : 0;
        console.log(`${h.slice(0, 18)}…  state=${STATES[lock.state]}  amount=${ethers.utils.formatEther(lock.amount)}  ` +
            `bounty=${ethers.utils.formatEther(lock.bounty)} POL  ` +
            (lock.state === 1 ? (refundable ? 'REFUNDABLE NOW' : `refundable in ~${waitMin} min`) : ''));

        if (cmd === 'refund' && refundable) {
            console.log('  → refunding…');
            const tx = await bridge.refundBurn(h, getGasSettings('refundBurn'));
            console.log(`  tx: ${tx.hash}`);
            await tx.wait();
            console.log('  ✓ refunded (tokens + bounty returned)');
        }
    }
    if (hashlocks.length === 0) console.log('No locks found for this wallet.');
}

main().catch((e) => { console.error(e.reason || e.message); process.exit(1); });
