#!/usr/bin/env node
/**
 * Replay a failed transaction with eth_call at its block and print the
 * revert reason.
 *
 * Usage: node scripts/debug-tx.js <txHash>
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { ethers } = require('ethers');
const { getPolygonProvider } = require('./gas-config');

async function main() {
    const hash = process.argv[2];
    if (!hash) throw new Error('Usage: node scripts/debug-tx.js <txHash>');
    const provider = getPolygonProvider();
    const tx = await provider.getTransaction(hash);
    if (!tx) throw new Error('Transaction not found');

    console.log(`Replaying ${hash} at block ${tx.blockNumber}…`);
    try {
        const result = await provider.call({
            from: tx.from, to: tx.to, data: tx.data, value: tx.value,
            gasLimit: tx.gasLimit,
        }, tx.blockNumber);
        console.log('Call did NOT revert on replay. Result:', result);
    } catch (e) {
        const body = e.error?.body || e.body || '';
        let data = e.error?.data || e.data;
        try { data = data || JSON.parse(body).error.data; } catch (_) {}
        if (typeof data === 'object' && data?.data) data = data.data;
        console.log('Raw revert data:', data);
        if (typeof data === 'string' && data.startsWith('0x08c379a0')) {
            const reason = ethers.utils.defaultAbiCoder.decode(['string'], '0x' + data.slice(10))[0];
            console.log(`\nREVERT REASON: "${reason}"`);
        } else if (typeof data === 'string' && data.startsWith('0x4e487b71')) {
            console.log('\nPanic code:', ethers.BigNumber.from('0x' + data.slice(10)).toString());
        } else {
            console.log('\nNo standard revert string. Full error:', e.reason || e.message);
        }
    }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
