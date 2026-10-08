#!/usr/bin/env node
/**
 * HTLC Evaluation Framework
 *
 * Runs multiple end-to-end HTLC transfers for academic evaluation.
 * Collects detailed metrics on gas usage, latency, and callback behavior.
 *
 * Usage:
 *   node htlc-evaluation.js run-batch N       # Run N complete lock→claim→burn cycles
 *   node htlc-evaluation.js analyze           # Analyze collected results
 *   node htlc-evaluation.js refund-test       # Execute timeout-refund scenario
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { ethers } = require('ethers');
const crypto = require('crypto');
const fs = require('fs');
const { getGasSettings, getPolygonProvider, formatGasInfo } = require('./gas-config');

// Contract addresses (from production deployment)
const CONFIG = {
    polygon: {
        token1155: process.env.POLYGON_TOKEN1155 || '0x7Dbf7583c758e34D2CB4F3fd1E8C998E5469345a',
        bridge: process.env.POLYGON_BRIDGE || '0x078154e912A94f57be962A7B3926dbcaF0eD27e0',
    },
    neutron: {
        contract: process.env.NEUTRON_BRIDGE_CONTRACT || 'neutron1d9k5ceh44555gxru06zk56cm8wd0hf683y77xncq9kmlzmaaxjyqgew60j',
        rpc: process.env.NEUTRON_RPC || 'https://rpc-kralum.neutron-1.neutron.org',
    },
    resultsFile: path.join(__dirname, 'evaluation-results.json'),
};

const RETRY_CONFIG = {
    maxRetries: 3,
    delayMs: 2000,
    backoffMultiplier: 1.5,
};

const RELAY_POLL_INTERVAL = 15000; // 15 seconds
const RELAY_MAX_WAIT = 1200000; // 20 minutes

// ============================================================================
// Utility Functions
// ============================================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryWithBackoff(fn, label = 'operation') {
    let delay = RETRY_CONFIG.delayMs;
    for (let attempt = 1; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
        try {
            return await fn();
        } catch (e) {
            if (attempt === RETRY_CONFIG.maxRetries) {
                console.error(`❌ ${label} failed after ${RETRY_CONFIG.maxRetries} retries:`, e.message);
                throw e;
            }
            console.warn(`⚠️  ${label} attempt ${attempt} failed, retrying in ${delay}ms...`);
            await sleep(delay);
            delay *= RETRY_CONFIG.backoffMultiplier;
        }
    }
}

function calculateStats(values) {
    if (values.length === 0) return { mean: 0, min: 0, max: 0, stdDev: 0 };

    const nums = values.map(Number);
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    const variance = nums.reduce((sq, n) => sq + Math.pow(n - mean, 2), 0) / nums.length;
    const stdDev = Math.sqrt(variance);

    return {
        mean: Math.round(mean * 100) / 100,
        min: Math.min(...nums),
        max: Math.max(...nums),
        stdDev: Math.round(stdDev * 100) / 100,
    };
}

function loadOrInitializeResults() {
    if (fs.existsSync(CONFIG.resultsFile)) {
        return JSON.parse(fs.readFileSync(CONFIG.resultsFile, 'utf8'));
    }
    return { runs: [], summary: {} };
}

function saveResults(results) {
    fs.writeFileSync(CONFIG.resultsFile, JSON.stringify(results, (_, v) => typeof v === 'bigint' ? Number(v) : v, 2));
}

// ============================================================================
// Contract Loading
// ============================================================================

async function loadContracts() {
    const privateKey = process.env.PRIVATE_KEY || process.env.EVM_PRIVATE_KEY;
    if (!privateKey) {
        throw new Error(
            'Missing private key. Set PRIVATE_KEY or EVM_PRIVATE_KEY in .env file.\n' +
            'Looked for .env at: ' + path.join(__dirname, '..', '.env')
        );
    }
    const provider = getPolygonProvider();
    const wallet = new ethers.Wallet(privateKey, provider);

    const bridgeAbi = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'artifacts/evm-contracts/BridgeHTLC.sol/BridgeHTLC.json')
    )).abi;

    const tokenAbi = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'artifacts/evm-contracts/IndicatorToken1155.sol/IndicatorToken1155.json')
    )).abi;

    return {
        provider,
        wallet,
        bridge: new ethers.Contract(CONFIG.polygon.bridge, bridgeAbi, wallet),
        token: new ethers.Contract(CONFIG.polygon.token1155, tokenAbi, wallet),
    };
}

async function loadCosmosClient() {
    const { SigningCosmWasmClient } = require('@cosmjs/cosmwasm-stargate');
    const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
    const { GasPrice } = require('@cosmjs/stargate');

    const mnemonic = process.env.COSMOS_MNEMONIC;
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: 'neutron' });
    const [account] = await wallet.getAccounts();

    const client = await SigningCosmWasmClient.connectWithSigner(
        CONFIG.neutron.rpc,
        wallet,
        { gasPrice: GasPrice.fromString('0.025untrn') }
    );

    return { client, wallet, account };
}

// ============================================================================
// Lock Operation
// ============================================================================

async function lockTokensForRun(amount = '1', recipient = 'neutron1n4ywn62cl3p6uzj0l8a66s3xsj7gg9qv78s8g7') {
    const { wallet, bridge, token } = await loadContracts();
    const gasSettings = getGasSettings('lockForBurn');

    const secret = '0x' + crypto.randomBytes(32).toString('hex');
    const hashlock = ethers.utils.keccak256(secret);
    const timelock = Math.floor(Date.now() / 1000) + 3600 + 300; // 1 hour + 5 min buffer for block.timestamp drift
    const tokenId = 1;
    const lockAmount = ethers.utils.parseEther(amount);

    // Check approval
    const isApproved = await token.isApprovedForAll(wallet.address, CONFIG.polygon.bridge);
    if (!isApproved) {
        console.log('  → Approving bridge...');
        const approveTx = await token.setApprovalForAll(CONFIG.polygon.bridge, true, getGasSettings('approve'));
        await approveTx.wait();
    }

    // Lock with retry
    console.log('  → Locking tokens on Polygon...');
    // Bounty for the fallback claimBurn path (returned on automatic callback / refund)
    const bounty = ethers.utils.parseEther(process.env.BOUNTY_POL || '0.1');
    const lockTx = await retryWithBackoff(async () => {
        return await bridge.lockForBurn(
            tokenId,
            lockAmount,
            hashlock,
            timelock,
            recipient,
            'neutron',
            CONFIG.neutron.contract,
            bounty,
            {
                ...gasSettings,
                value: ethers.utils.parseEther('1'), // GMP gas + bounty (bounty stays escrowed)
            }
        );
    }, 'Lock transaction');

    const lockReceipt = await lockTx.wait();
    const lockTimestamp = Math.floor(Date.now() / 1000);

    return {
        secret,
        hashlock,
        tokenId,
        amount,
        recipient,
        timelock,
        lock: {
            txHash: lockTx.hash,
            gasUsed: lockReceipt.gasUsed.toNumber(),
            timestamp: lockTimestamp,
            blockNumber: lockReceipt.blockNumber,
        },
    };
}

// ============================================================================
// Relay Monitoring
// ============================================================================

async function waitForRelayWithPolling(hashlock, maxWait = RELAY_MAX_WAIT) {
    console.log('  → Waiting for Axelar GMP relay (polling every 15s)...');
    const startTime = Date.now();
    const polledAt = [];

    while (Date.now() - startTime < maxWait) {
        try {
            const { client } = await loadCosmosClient();
            const htlc = await client.queryContractSmart(CONFIG.neutron.contract, {
                h_t_l_c_lock: { hashlock }
            });

            if (htlc && htlc.lock) {
                const relayLatency = Math.round((Date.now() - startTime) / 1000);
                console.log(`  ✓ HTLC appeared on Cosmos after ${relayLatency}s`);
                return { relayLatencySeconds: relayLatency, polledAt };
            }
        } catch (e) {
            // HTLC not found yet, continue polling
        }

        polledAt.push(new Date().toISOString());
        await sleep(RELAY_POLL_INTERVAL);
    }

    throw new Error(`Relay timeout: HTLC not found on Cosmos after ${maxWait / 1000}s`);
}

// ============================================================================
// Claim on Cosmos
// ============================================================================

async function claimOnCosmosForRun(hashlock, secret) {
    const { client, account } = await loadCosmosClient();

    // Verify HTLC state
    try {
        const htlc = await client.queryContractSmart(CONFIG.neutron.contract, {
            h_t_l_c_lock: { hashlock }
        });

        if (htlc.lock.state !== 'pending') {
            throw new Error(`HTLC state is ${htlc.lock.state}, expected pending`);
        }
    } catch (e) {
        throw new Error(`Failed to verify HTLC: ${e.message}`);
    }

    console.log('  → Claiming on Cosmos (funds attached: on-chain automatic callback)...');
    // TWO coins attached (sorted by denom, as the chain requires):
    //   - AXL (Axelar-registered asset): transferred to the Axelar GMP
    //     account as the relayer fee that pays for Polygon execution.
    //     NTRN is NOT an Axelar asset — untrn transfers get error-acked.
    //   - untrn: covers Neutron's mandatory feerefunder ack+timeout fees
    //     (0.2+0.2 NTRN; timeout fee refunded on success).
    const AXL_DENOM = process.env.AXL_DENOM
        || 'ibc/C0E66D1C81D8AAF0E6896E05190FDFBC222367148F86AC3EA679C28327A763CD';
    const relayFeeAxl = process.env.CALLBACK_FEE_UAXL || '2000000'; // 2 AXL
    const feerefunderUntrn = process.env.FEEREFUNDER_UNTRN || '450000';
    const funds = [
        { denom: AXL_DENOM, amount: relayFeeAxl },
        { denom: 'untrn', amount: feerefunderUntrn },
    ].sort((a, b) => a.denom.localeCompare(b.denom));
    const claimResult = await retryWithBackoff(async () => {
        return await client.execute(
            account.address,
            CONFIG.neutron.contract,
            { claim_mint: { hashlock, secret } },
            'auto',
            undefined,
            funds
        );
    }, 'Cosmos claim');

    const claimTimestamp = Math.floor(Date.now() / 1000);

    // Extract gas used from the result
    const gasUsed = claimResult.gasUsed || 0;

    return {
        claim: {
            txHash: claimResult.transactionHash,
            gasUsed,
            timestamp: claimTimestamp,
        },
    };
}

// ============================================================================
// Burn on EVM
// ============================================================================

/**
 * Wait for the AUTOMATIC callback (Neutron -> Axelar -> Polygon) to execute
 * the burn: polls the lock state until CLAIMED (2). Returns null on timeout.
 */
async function waitForAutomaticBurn(
    hashlock,
    // Cosmos->EVM callbacks ride public IBC relayers (batch-cleared) plus
    // Axelar routing; observed end-to-end up to ~40 min on slow days.
    maxWait = parseInt(process.env.CALLBACK_MAX_WAIT_MS || String(45 * 60 * 1000), 10)
) {
    const { bridge } = await loadContracts();
    console.log('  → Waiting for automatic callback burn on Polygon (polling every 15s)...');
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
        const lock = await bridge.getLock(hashlock);
        if (lock.state === 2) { // CLAIMED
            const latency = Math.round((Date.now() - startTime) / 1000);
            console.log(`  ✓ Escrow burned by automatic callback after ${latency}s`);
            return {
                mode: 'automatic-callback',
                callbackLatencySeconds: latency,
                timestamp: Math.floor(Date.now() / 1000),
            };
        }
        await sleep(RELAY_POLL_INTERVAL);
    }
    console.warn(`  ! Automatic callback not observed within ${maxWait / 1000}s`);
    return null;
}

async function burnOnEVMForRun(hashlock, secret) {
    const { wallet, bridge, token } = await loadContracts();
    const gasSettings = getGasSettings('claimBurn');

    // Check lock state
    const lock = await bridge.getLock(hashlock);
    if (lock.state !== 1) { // LOCKED
        throw new Error(`Lock state is ${lock.state}, expected 1 (LOCKED)`);
    }

    console.log('  → Burning on Polygon...');
    const burnTx = await retryWithBackoff(async () => {
        return await bridge.claimBurn(hashlock, secret, gasSettings);
    }, 'Burn transaction');

    const burnReceipt = await burnTx.wait();
    const burnTimestamp = Math.floor(Date.now() / 1000);

    // Check if callback was triggered (look for events)
    const wasCallback = false; // We'll set this to true if we detect a callback event

    return {
        burn: {
            txHash: burnTx.hash,
            gasUsed: burnReceipt.gasUsed.toNumber(),
            timestamp: burnTimestamp,
            blockNumber: burnReceipt.blockNumber,
            wasCallback,
        },
    };
}

// ============================================================================
// Run Batch
// ============================================================================

async function runBatch(numRuns = 1) {
    console.log('\n========================================');
    console.log(`📊 HTLC EVALUATION: Running ${numRuns} cycles`);
    console.log('========================================\n');

    const { wallet, bridge, token } = await loadContracts();
    console.log(`Wallet: ${wallet.address}`);
    console.log(`Token contract: ${CONFIG.polygon.token1155}`);
    console.log(`Bridge contract: ${CONFIG.polygon.bridge}`);

    // Pre-flight checks
    const maticBalance = await wallet.getBalance();
    console.log(`MATIC balance: ${ethers.utils.formatEther(maticBalance)}`);

    const tokenBalance = await token.balanceOf(wallet.address, 1);
    console.log(`Token balance (tokenId=1): ${ethers.utils.formatEther(tokenBalance)}`);

    const isApproved = await token.isApprovedForAll(wallet.address, CONFIG.polygon.bridge);
    console.log(`Bridge approved: ${isApproved}`);

    const neededTokens = ethers.utils.parseEther(String(numRuns));
    if (tokenBalance.lt(neededTokens)) {
        console.error(`\n❌ Insufficient token balance. Have ${ethers.utils.formatEther(tokenBalance)}, need ${numRuns}.`);
        console.error('Mint more tokens or reduce the number of runs.');
        process.exit(1);
    }

    const neededMatic = ethers.utils.parseEther(String(numRuns * 1.5)); // ~1 MATIC relay + gas per run
    if (maticBalance.lt(neededMatic)) {
        console.error(`\n❌ Insufficient MATIC. Have ${ethers.utils.formatEther(maticBalance)}, estimate need ~${numRuns * 1.5}.`);
        process.exit(1);
    }

    console.log(`Results file: ${CONFIG.resultsFile}\n`);

    const results = loadOrInitializeResults();
    const startingRunNumber = results.runs.length + 1;

    for (let i = 0; i < numRuns; i++) {
        const runNumber = startingRunNumber + i;
        console.log(`\n--- Run ${runNumber}/${startingRunNumber + numRuns - 1} ---`);

        try {
            const runStartTime = Date.now();
            let runData = {
                run_number: runNumber,
                success: false,
                totalTimeSeconds: 0,
                lock: null,
                relay: null,
                claim: null,
                burn: null,
            };

            // Step 0: PRE-FLIGHT — verify Neutron-side funds BEFORE locking.
            // A lock whose claim will fail for lack of AXL/NTRN strands an
            // escrow and burns the relay fee for nothing (observed: 50 runs).
            {
                const { client, account } = await loadCosmosClient();
                const AXL_DENOM = process.env.AXL_DENOM
                    || 'ibc/C0E66D1C81D8AAF0E6896E05190FDFBC222367148F86AC3EA679C28327A763CD';
                const needAxl = BigInt(process.env.CALLBACK_FEE_UAXL || '2000000');
                const needUntrn = BigInt(process.env.FEEREFUNDER_UNTRN || '450000') + 30000n; // + gas margin
                const axl = BigInt((await client.getBalance(account.address, AXL_DENOM)).amount);
                const untrn = BigInt((await client.getBalance(account.address, 'untrn')).amount);
                if (axl < needAxl || untrn < needUntrn) {
                    throw new Error(`PRE-FLIGHT ABORT (no lock created): insufficient Neutron funds — ` +
                        `AXL ${axl}/${needAxl}, untrn ${untrn}/${needUntrn}. Top up before continuing.`);
                }
            }

            // Step 1: Lock
            console.log('Step 1: Lock tokens');
            const lockData = await lockTokensForRun('1');
            runData.lock = lockData.lock;
            const { secret, hashlock } = lockData;
            console.log(`  ✓ Locked: ${lockData.lock.txHash}`);
            console.log(`  ✓ Gas used: ${lockData.lock.gasUsed}`);

            // Step 2: Wait for relay
            console.log('Step 2: Wait for GMP relay');
            const relayData = await waitForRelayWithPolling(hashlock);
            runData.relay = relayData;

            // Step 3: Claim on Cosmos
            console.log('Step 3: Claim on Cosmos');
            const claimData = await claimOnCosmosForRun(hashlock, secret);
            runData.claim = claimData.claim;
            console.log(`  ✓ Claimed: ${claimData.claim.txHash}`);
            console.log(`  ✓ Gas used: ${claimData.claim.gasUsed}`);

            // Step 4: Burn on EVM — prefer the AUTOMATIC callback (the
            // protocol's happy path); fall back to manual claimBurn (the
            // monitor path) only if the callback does not land in time.
            console.log('Step 4: Burn on Polygon (automatic callback)');
            const auto = await waitForAutomaticBurn(hashlock);
            if (auto) {
                runData.burn = {
                    mode: auto.mode,
                    timestamp: auto.timestamp,
                    callbackLatencySeconds: auto.callbackLatencySeconds,
                    wasCallback: true,
                };
            } else {
                console.log('  → Falling back to manual claimBurn (monitor path)');
                const burnData = await burnOnEVMForRun(hashlock, secret);
                runData.burn = { ...burnData.burn, mode: 'manual-fallback' };
                console.log(`  ✓ Burned: ${burnData.burn.txHash}`);
            }

            // Calculate total time
            const totalTime = Math.round((Date.now() - runStartTime) / 1000);
            runData.totalTimeSeconds = totalTime;
            runData.success = true;

            console.log(`\n  ✅ Run ${runNumber} completed in ${totalTime}s`);

            results.runs.push(runData);
            saveResults(results);

            if (i < numRuns - 1) {
                const waitBetweenRuns = 30000; // 30 seconds between runs
                console.log(`⏳ Waiting 30s before next run...`);
                await sleep(waitBetweenRuns);
            }
        } catch (e) {
            console.error(`\n  ❌ Run ${runNumber} failed: ${e.message}`);
            results.runs.push({
                run_number: runNumber,
                success: false,
                error: e.message,
            });
            saveResults(results);
        }
    }

    // Compute summary
    console.log('\n========================================');
    console.log('📈 COMPUTING SUMMARY STATISTICS');
    console.log('========================================\n');

    computeSummary(results);
    saveResults(results);

    console.log('✅ Evaluation complete. Results saved to evaluation-results.json\n');
}

// ============================================================================
// Summary Computation
// ============================================================================

function computeSummary(results) {
    const successfulRuns = results.runs.filter(r => r.success);
    const totalRuns = results.runs.length;
    const successfulCount = successfulRuns.length;

    const lockGasValues = successfulRuns.map(r => r.lock?.gasUsed || 0).filter(v => v > 0);
    const claimGasValues = successfulRuns.map(r => r.claim?.gasUsed || 0).filter(v => v > 0);
    const burnGasValues = successfulRuns.map(r => r.burn?.gasUsed || 0).filter(v => v > 0);
    const relayLatencyValues = successfulRuns.map(r => r.relay?.relayLatencySeconds || 0).filter(v => v > 0);
    const totalTimeValues = successfulRuns.map(r => r.totalTimeSeconds || 0).filter(v => v > 0);

    // Fraction of COMPLETED transfers that were settled by the automatic callback rather
    // than by the fallback path. Computed from the recorded burn mode; it was previously a
    // hardcoded 0.8 placeholder, which published a figure that no run had measured.
    const callbackRuns = successfulRuns.filter(r => r.burn?.wasCallback === true
        || r.burn?.mode === 'automatic-callback');
    const callbackSuccessRate = successfulCount > 0
        ? callbackRuns.length / successfulCount
        : null;

    // Aborted attempts, reported explicitly so that totalRuns is not mistaken for a
    // success rate. An attempt that failed before submitting the source lock has no
    // on-chain effect.
    const abortedRuns = results.runs.filter(r => !r.success);
    const abortedBeforeLock = abortedRuns.filter(r => !r.lock).length;

    const summary = {
        totalRuns,
        successfulRuns: successfulCount,
        abortedRuns: abortedRuns.length,
        abortedBeforeLock,
        lockGas: calculateStats(lockGasValues),
        claimGas: calculateStats(claimGasValues),
        burnGas: calculateStats(burnGasValues),
        relayLatency: calculateStats(relayLatencyValues),
        totalTime: calculateStats(totalTimeValues),
        callbackSuccessRate,
        callbackRuns: callbackRuns.length,
    };

    results.summary = summary;

    // Print formatted summary
    console.log(`Successful runs: ${successfulCount}/${totalRuns}`);
    console.log('\nLock Gas (Wei):');
    console.log(`  Mean: ${summary.lockGas.mean}, Min: ${summary.lockGas.min}, Max: ${summary.lockGas.max}, StdDev: ${summary.lockGas.stdDev}`);
    console.log('\nClaim Gas (Wei):');
    console.log(`  Mean: ${summary.claimGas.mean}, Min: ${summary.claimGas.min}, Max: ${summary.claimGas.max}, StdDev: ${summary.claimGas.stdDev}`);
    console.log('\nBurn Gas (Wei):');
    console.log(`  Mean: ${summary.burnGas.mean}, Min: ${summary.burnGas.min}, Max: ${summary.burnGas.max}, StdDev: ${summary.burnGas.stdDev}`);
    console.log('\nRelay Latency (seconds):');
    console.log(`  Mean: ${summary.relayLatency.mean}, Min: ${summary.relayLatency.min}, Max: ${summary.relayLatency.max}, StdDev: ${summary.relayLatency.stdDev}`);
    console.log('\nTotal Time (seconds):');
    console.log(`  Mean: ${summary.totalTime.mean}, Min: ${summary.totalTime.min}, Max: ${summary.totalTime.max}, StdDev: ${summary.totalTime.stdDev}`);
    console.log(`\nCallback Success Rate: ${(summary.callbackSuccessRate * 100).toFixed(1)}%`);
}

// ============================================================================
// Analyze Results
// ============================================================================

async function analyzeResults() {
    console.log('\n========================================');
    console.log('📊 HTLC EVALUATION RESULTS ANALYSIS');
    console.log('========================================\n');

    if (!fs.existsSync(CONFIG.resultsFile)) {
        console.log('No evaluation-results.json found. Run "node htlc-evaluation.js run-batch N" first.');
        return;
    }

    const results = JSON.parse(fs.readFileSync(CONFIG.resultsFile, 'utf8'));

    if (results.runs.length === 0) {
        console.log('No runs recorded yet.');
        return;
    }

    console.log(`Total runs: ${results.runs.length}`);
    const successfulRuns = results.runs.filter(r => r.success);
    console.log(`Successful: ${successfulRuns.length}`);
    console.log(`Failed: ${results.runs.length - successfulRuns.length}\n`);

    if (!results.summary || !results.summary.lockGas) {
        console.log('Recomputing summary from raw data...\n');
        computeSummary(results);
        saveResults(results);
    }

    if (results.summary) {
        console.log('SUMMARY STATISTICS:\n');
        console.log('Lock Gas Usage (Wei):');
        console.log(formatStatLine(results.summary.lockGas));

        console.log('\nClaim Gas Usage (Wei):');
        console.log(formatStatLine(results.summary.claimGas));

        console.log('\nBurn Gas Usage (Wei):');
        console.log(formatStatLine(results.summary.burnGas));

        console.log('\nRelay Latency (seconds):');
        console.log(formatStatLine(results.summary.relayLatency));

        console.log('\nTotal End-to-End Time (seconds):');
        console.log(formatStatLine(results.summary.totalTime));

        console.log(`\nCallback Success Rate: ${(results.summary.callbackSuccessRate * 100).toFixed(1)}%`);
    }

    // LaTeX table format
    console.log('\n\n--- LaTeX TABLE FORMAT ---\n');
    printLaTeXTable(results.summary);

    console.log('\nDetailed run data saved in evaluation-results.json\n');
}

function formatStatLine(stats) {
    return `  Mean: ${stats.mean.toLocaleString()} | Min: ${stats.min.toLocaleString()} | Max: ${stats.max.toLocaleString()} | StdDev: ${stats.stdDev.toLocaleString()}`;
}

function printLaTeXTable(summary) {
    const metrics = [
        { name: 'Lock Gas (Wei)', data: summary.lockGas },
        { name: 'Claim Gas (Wei)', data: summary.claimGas },
        { name: 'Burn Gas (Wei)', data: summary.burnGas },
        { name: 'Relay Latency (s)', data: summary.relayLatency },
        { name: 'Total Time (s)', data: summary.totalTime },
    ];

    console.log('\\begin{table}[h]');
    console.log('\\centering');
    console.log('\\begin{tabular}{|l|r|r|r|r|}');
    console.log('\\hline');
    console.log('Metric & Mean & Min & Max & StdDev \\\\');
    console.log('\\hline');

    for (const metric of metrics) {
        const { mean, min, max, stdDev } = metric.data;
        console.log(`${metric.name} & ${mean} & ${min} & ${max} & ${stdDev} \\\\`);
    }

    console.log('\\hline');
    console.log('\\end{tabular}');
    console.log('\\end{table}');
}

// ============================================================================
// Refund Test
// ============================================================================

async function refundTest() {
    console.log('\n========================================');
    console.log('💰 REFUND TIMEOUT TEST');
    console.log('========================================\n');

    const { wallet } = await loadContracts();
    console.log(`Wallet: ${wallet.address}`);

    try {
        // Lock with 1 hour timeout
        console.log('\n1️⃣  Locking tokens with 1-hour timeout...');
        const lockData = await lockTokensForRun('1');
        const { secret, hashlock } = lockData;
        console.log(`  ✓ Locked: ${lockData.lock.txHash}`);

        // Wait for relay
        console.log('\n2️⃣  Waiting for GMP relay...');
        const relayData = await waitForRelayWithPolling(hashlock);
        console.log(`  ✓ HTLC appeared on Cosmos after ${relayData.relayLatencySeconds}s`);

        // DO NOT claim - wait for Cosmos timeout to expire
        const cosmosTimeoutDuration = lockData.timelock - 30 * 60; // timelock - 30min buffer
        const cosmosWaitSeconds = cosmosTimeoutDuration - Math.floor(Date.now() / 1000) + 60; // +60s safety margin
        console.log(`\n3️⃣  ⏰ NOT claiming - waiting ${Math.round(cosmosWaitSeconds / 60)} min for Cosmos timeout...`);
        console.log(`  Cosmos timeout expires at: ${new Date(cosmosTimeoutDuration * 1000).toISOString()}`);
        
        const logInterval = setInterval(() => {
            const remaining = cosmosTimeoutDuration + 60 - Math.floor(Date.now() / 1000);
            if (remaining > 0) console.log(`  ⏳ ${Math.round(remaining / 60)} min remaining...`);
        }, 300000); // log every 5 min
        
        await sleep(Math.max(cosmosWaitSeconds, 0) * 1000);
        clearInterval(logInterval);
        console.log('  ✓ Cosmos timeout expired');

        // Call refund on Cosmos
        console.log('\n4️⃣  Calling refund_mint on Cosmos...');
        const { client, account } = await loadCosmosClient();

        const refundMintResult = await retryWithBackoff(async () => {
            return await client.execute(
                account.address,
                CONFIG.neutron.contract,
                { refund_mint: { hashlock } },
                'auto'
            );
        }, 'Cosmos refund_mint');

        console.log(`  ✓ Refund mint TX: ${refundMintResult.transactionHash}`);
        console.log(`  ✓ Gas used: ${refundMintResult.gasUsed}`);

        // Wait for EVM timeout
        const evmWaitSeconds = lockData.timelock - Math.floor(Date.now() / 1000) + 60; // +60s safety
        if (evmWaitSeconds > 0) {
            console.log(`\n  ⏰ Waiting ${Math.round(evmWaitSeconds / 60)} min for EVM timeout...`);
            await sleep(evmWaitSeconds * 1000);
        }
        console.log('  ✓ EVM timeout expired');

        // Call refundBurn on EVM
        console.log('\n5️⃣  Calling refundBurn on Polygon...');
        const { bridge } = await loadContracts();
        const gasSettings = getGasSettings('refundBurn');

        const refundTx = await retryWithBackoff(async () => {
            return await bridge.refundBurn(hashlock, gasSettings);
        }, 'Refund burn transaction');

        const refundReceipt = await refundTx.wait();
        console.log(`  ✓ Refund burn TX: ${refundTx.hash}`);
        console.log(`  ✓ Gas used: ${refundReceipt.gasUsed.toString()}`);

        // Verify lock state
        const finalLock = await bridge.getLock(hashlock);
        const stateNames = ['EMPTY', 'LOCKED', 'CLAIMED', 'REFUNDED'];
        console.log(`\n  ✓ Final lock state: ${stateNames[finalLock.state]}`);

        console.log('\n✅ Refund test completed successfully!\n');
    } catch (e) {
        console.error(`\n❌ Refund test failed: ${e.message}\n`);
        throw e;
    }
}

// ============================================================================
// Main
// ============================================================================

const command = process.argv[2];
const arg1 = process.argv[3];

switch (command) {
    case 'run-batch':
        const numRuns = parseInt(arg1, 10) || 1;
        runBatch(numRuns).catch(console.error);
        break;
    case 'analyze':
        analyzeResults().catch(console.error);
        break;
    case 'refund-test':
        refundTest().catch(console.error);
        break;
    default:
        console.log(`
HTLC Evaluation Framework

Usage:
  node htlc-evaluation.js run-batch N       # Run N complete lock→claim→burn cycles
  node htlc-evaluation.js analyze           # Analyze collected results
  node htlc-evaluation.js refund-test       # Execute timeout-refund scenario

Environment Variables:
  PRIVATE_KEY (or EVM_PRIVATE_KEY)    - EVM wallet private key
  COSMOS_MNEMONIC                     - Cosmos wallet mnemonic
        `);
        break;
}
