#!/usr/bin/env node
/**
 * One-off: point the Polygon BridgeHTLC at the Neutron counterpart
 * (authorizes reverse-direction prepare-mint messages).
 *
 * Usage: node scripts/set-authorized-source.js
 * Env:   POLYGON_BRIDGE, NEUTRON_BRIDGE_CONTRACT, EVM_PRIVATE_KEY
 *        (optional NEUTRON_CHAIN_NAME, default "neutron")
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { ethers } = require('ethers');
const fs = require('fs');
const { getGasSettings, getPolygonProvider } = require('./gas-config');

async function main() {
    const bridgeAddr = process.env.POLYGON_BRIDGE;
    const neutronContract = process.env.NEUTRON_BRIDGE_CONTRACT;
    if (!bridgeAddr || !neutronContract) throw new Error('Set POLYGON_BRIDGE and NEUTRON_BRIDGE_CONTRACT in .env');

    const provider = getPolygonProvider();
    const wallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY || process.env.PRIVATE_KEY, provider);
    const abi = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'artifacts/evm-contracts/BridgeHTLC.sol/BridgeHTLC.json'))).abi;
    const bridge = new ethers.Contract(bridgeAddr, abi, wallet);

    const chain = process.env.NEUTRON_CHAIN_NAME || 'neutron';
    console.log(`setAuthorizedSource(${chain}, ${neutronContract}) on ${bridgeAddr}…`);
    const tx = await bridge.setAuthorizedSource(chain, neutronContract, getGasSettings('createClass'));
    console.log(`tx: ${tx.hash}`);
    await tx.wait();
    console.log(`Done. authorizedSourceAddress = ${await bridge.authorizedSourceAddress()}`);
}

main().catch((e) => { console.error(e.reason || e.message); process.exit(1); });
