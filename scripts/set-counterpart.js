#!/usr/bin/env node
/**
 * v1.1: set the expected source of prepare_mint on the Neutron bridge
 * contract (owner only). prepare_mint fails closed until this is set.
 *
 * Usage:
 *   node scripts/set-counterpart.js <axelar_chain_name> <bridge_htlc_address>
 *   e.g. node scripts/set-counterpart.js Polygon 0x...
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
    const [chain, address] = process.argv.slice(2);
    const contract = process.env.NEUTRON_BRIDGE_CONTRACT;
    if (!contract) throw new Error('Set NEUTRON_BRIDGE_CONTRACT in .env');
    if (!chain || !address) {
        console.log('Usage: node scripts/set-counterpart.js <axelar_chain_name> <bridge_htlc_address>');
        process.exit(1);
    }
    const { client, account } = await connect();
    const res = await client.execute(account.address, contract,
        { set_counterpart: { chain, address } }, 'auto');
    console.log(`Counterpart set to ${chain}/${address}\ntx: ${res.transactionHash}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
