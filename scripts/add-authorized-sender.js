#!/usr/bin/env node
/**
 * Manage AUTHORIZED_SENDERS on the Neutron bridge contract.
 *
 * Usage:
 *   node scripts/add-authorized-sender.js add <sender_address>
 *
 * The sender to authorize is the IBC-hook intermediary address derived from
 * the Axelar GMP account and the Neutron<->Axelar channel:
 *   Bech32(Hash("ibc-wasm-hook-intermediary" || channel || axelar_gmp_account))
 * It is the `sender` you see on the prepare_mint executions of the OLD
 * contract on Mintscan — copy it from there, or from your previous notes.
 *
 * Env: COSMOS_MNEMONIC, NEUTRON_RPC, NEUTRON_BRIDGE_CONTRACT (target contract)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { SigningCosmWasmClient } = require('@cosmjs/cosmwasm-stargate');
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { GasPrice } = require('@cosmjs/stargate');

const RPCS = [
    process.env.NEUTRON_RPC,
    'https://rpc-lb.neutron.org',
    'https://neutron-rpc.publicnode.com',
    'https://neutron-rpc.polkachu.com',
].filter(Boolean);

async function connect() {
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(process.env.COSMOS_MNEMONIC, { prefix: 'neutron' });
    const [account] = await wallet.getAccounts();
    for (const url of RPCS) {
        try {
            const client = await SigningCosmWasmClient.connectWithSigner(url, wallet, {
                gasPrice: GasPrice.fromString('0.025untrn'),
            });
            console.log(`RPC: ${url}`);
            return { client, account };
        } catch (e) { console.warn(`RPC unavailable: ${url}`); }
    }
    throw new Error('No Neutron RPC reachable');
}

async function main() {
    const [cmd, arg] = process.argv.slice(2);
    const contract = process.env.NEUTRON_BRIDGE_CONTRACT;
    if (!contract) throw new Error('Set NEUTRON_BRIDGE_CONTRACT in .env');
    if (cmd !== 'add' || !arg) {
        console.log('Usage: node scripts/add-authorized-sender.js add <sender_address>');
        process.exit(1);
    }
    const { client, account } = await connect();
    const res = await client.execute(account.address, contract,
        { add_authorized_sender: { sender: arg } }, 'auto');
    console.log(`Authorized ${arg}\ntx: ${res.transactionHash}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
