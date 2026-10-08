#!/usr/bin/env node
/**
 * Local compilation via solc-js (no network access needed).
 * Used by the unit tests in test/. Mainnet deployments should keep using
 * `npx hardhat compile` (solc 0.8.19 per hardhat.config.js).
 *
 * Output: artifacts-local/<ContractName>.json  { abi, bytecode }
 */
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts-local');

const SOURCES = [
    'evm-contracts/BridgeHTLC.sol',
    'evm-contracts/IndicatorToken1155.sol',
    'evm-contracts/mocks/AxelarMocks.sol',
];

function findImport(importPath) {
    // Resolve node_modules imports (@axelar-network/..., @openzeppelin/...)
    const candidates = [
        path.join(ROOT, 'node_modules', importPath),
        path.join(ROOT, importPath),
        path.join(ROOT, 'evm-contracts', importPath),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return { contents: fs.readFileSync(c, 'utf8') };
    }
    return { error: 'File not found: ' + importPath };
}

const input = {
    language: 'Solidity',
    sources: Object.fromEntries(
        SOURCES.map((s) => [s, { content: fs.readFileSync(path.join(ROOT, s), 'utf8') }])
    ),
    settings: {
        viaIR: true,
        optimizer: { enabled: true, runs: 1000 },
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
};

console.log(`Compiling with solc ${solc.version()} ...`);
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));

const errors = (output.errors || []).filter((e) => e.severity === 'error');
const warnings = (output.errors || []).filter((e) => e.severity === 'warning');
warnings.slice(0, 5).forEach((w) => console.warn('WARN:', w.formattedMessage.split('\n')[0]));
if (errors.length) {
    errors.forEach((e) => console.error(e.formattedMessage));
    process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
let count = 0;
for (const [file, contracts] of Object.entries(output.contracts)) {
    for (const [name, data] of Object.entries(contracts)) {
        // Only write top-level project contracts (skip node_modules internals)
        if (!file.startsWith('evm-contracts/')) continue;
        fs.writeFileSync(
            path.join(OUT, `${name}.json`),
            JSON.stringify({ contractName: name, sourceFile: file, abi: data.abi, bytecode: '0x' + data.evm.bytecode.object }, null, 2)
        );
        count++;
    }
}
console.log(`Wrote ${count} artifacts to artifacts-local/`);
