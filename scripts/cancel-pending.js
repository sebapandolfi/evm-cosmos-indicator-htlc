#!/usr/bin/env node
/**
 * Unblock a stuck account by replacing the lowest pending nonce with a
 * 0-value self-transfer at aggressive fees.
 *
 * Usage: node scripts/cancel-pending.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { ethers } = require('ethers');
const { getPolygonProvider } = require('./gas-config');

async function main() {
    const provider = getPolygonProvider();
    const wallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY, provider);

    const confirmed = await provider.getTransactionCount(wallet.address, 'latest');
    const pending = await provider.getTransactionCount(wallet.address, 'pending');
    console.log(`Account: ${wallet.address}`);
    console.log(`Confirmed nonce: ${confirmed}, pending nonce: ${pending}`);

    if (pending === confirmed) {
        console.log('Nothing pending — account is not blocked.');
        return;
    }

    const feeData = await provider.getFeeData();
    const maxFeePerGas = (feeData.maxFeePerGas || ethers.utils.parseUnits('400', 'gwei')).mul(150).div(100);
    const maxPriorityFeePerGas = ethers.utils.parseUnits(process.env.PRIORITY_GWEI || '60', 'gwei');

    console.log(`Replacing nonce ${confirmed} with a 0-value self-transfer at ` +
        `${ethers.utils.formatUnits(maxFeePerGas, 'gwei')} gwei max fee…`);
    const tx = await wallet.sendTransaction({
        to: wallet.address,
        value: 0,
        nonce: confirmed,
        gasLimit: 21000,
        maxFeePerGas,
        maxPriorityFeePerGas,
    });
    console.log(`Replacement tx: ${tx.hash}`);
    await tx.wait();
    console.log('Confirmed. Re-run your original script now.');
}

main().catch((e) => { console.error(e.reason || e.message); process.exit(1); });
