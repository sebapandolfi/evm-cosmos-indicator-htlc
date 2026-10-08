#!/usr/bin/env node
/**
 * One-off: mint initial supply to the deployer (owner-only mintInitialSupply).
 * Usage: TOKEN1155_ADDRESS=0x… node scripts/mint-initial.js [tokenId] [amountEther]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { ethers } = require('ethers');
const fs = require('fs');
const { getGasSettings, getPolygonProvider } = require('./gas-config');

async function main() {
    const tokenAddress = process.env.TOKEN1155_ADDRESS;
    if (!tokenAddress) throw new Error('Set TOKEN1155_ADDRESS');
    const tokenId = process.argv[2] || '1';
    const amount = ethers.utils.parseEther(process.argv[3] || '100');

    const provider = getPolygonProvider();
    const wallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY || process.env.PRIVATE_KEY, provider);
    const abi = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'artifacts/evm-contracts/IndicatorToken1155.sol/IndicatorToken1155.json'))).abi;
    const token = new ethers.Contract(tokenAddress, abi, wallet);

    console.log(`Minting ${ethers.utils.formatEther(amount)} of tokenId ${tokenId} to ${wallet.address}…`);
    const tx = await token.mintInitialSupply(wallet.address, tokenId, amount, getGasSettings('mint'));
    console.log(`tx: ${tx.hash}`);
    await tx.wait();
    console.log(`Done. Balance: ${ethers.utils.formatEther(await token.balanceOf(wallet.address, tokenId))}`);
}

main().catch((e) => { console.error(e.reason || e.message); process.exit(1); });
