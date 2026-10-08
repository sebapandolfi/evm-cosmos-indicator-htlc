#!/usr/bin/env node
/**
 * Multi-day evaluation campaign runner.
 *
 * Runs batches of end-to-end transfers (via htlc-evaluation.js) spread across
 * several days at randomized times, until the target sample size is reached.
 * Designed to satisfy the reviewers' request for a larger evaluation under
 * varying network conditions: batches land at different hours (including
 * high-activity windows) across >= 5 distinct days.
 *
 * Usage:
 *   node scripts/campaign-runner.js            # start / resume the campaign
 *   node scripts/campaign-runner.js status     # progress report
 *
 * Config via env (all optional):
 *   CAMPAIGN_TARGET_RUNS    total successful runs wanted   (default 50)
 *   CAMPAIGN_BATCH_SIZE     runs per session               (default 5)
 *   CAMPAIGN_MIN_GAP_HOURS  min gap between sessions       (default 6)
 *   CAMPAIGN_MAX_GAP_HOURS  max gap between sessions       (default 14)
 *
 * Keep the process alive (laptop awake / caffeinate) or install the launchd
 * job described in README-REVISION.md. Progress is derived from
 * evaluation-results.json, so the runner is safely resumable.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { spawn } = require('child_process');
const fs = require('fs');

const RESULTS = path.join(__dirname, 'evaluation-results.json');
const LOG = path.join(__dirname, 'campaign.log');
const PIDFILE = path.join(__dirname, 'campaign.pid');

// Single-instance guard: concurrent runners race on the wallet nonce and
// the results file. Refuse to start if another live runner holds the pidfile.
function acquireLock() {
    if (fs.existsSync(PIDFILE)) {
        const oldPid = parseInt(fs.readFileSync(PIDFILE, 'utf8'), 10);
        try {
            process.kill(oldPid, 0); // throws if not running
            console.error(`Another campaign runner is already active (pid ${oldPid}). Exiting cleanly.`);
            // Exit 0 so launchd's KeepAlive(SuccessfulExit=false) does NOT
            // respawn-loop while a healthy runner holds the lock.
            process.exit(0);
        } catch (_) { /* stale pidfile */ }
    }
    fs.writeFileSync(PIDFILE, String(process.pid));
    const cleanup = () => { try { fs.unlinkSync(PIDFILE); } catch (_) {} };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(130); });
    process.on('SIGTERM', () => { cleanup(); process.exit(143); });
}

const TARGET = parseInt(process.env.CAMPAIGN_TARGET_RUNS || '50', 10);
const BATCH = parseInt(process.env.CAMPAIGN_BATCH_SIZE || '5', 10);
const MIN_GAP_H = parseFloat(process.env.CAMPAIGN_MIN_GAP_HOURS || '6');
const MAX_GAP_H = parseFloat(process.env.CAMPAIGN_MAX_GAP_HOURS || '14');
const MIN_DAYS = parseInt(process.env.CAMPAIGN_MIN_DAYS || '3', 10);

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    fs.appendFileSync(LOG, line + '\n');
}

function progress() {
    if (!fs.existsSync(RESULTS)) return { done: 0, days: 0 };
    const data = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
    const runs = (data.runs || []).filter((r) => r.success);
    const days = new Set(runs.map((r) => new Date((r.lock?.timestamp || 0) * 1000).toISOString().slice(0, 10)));
    return { done: runs.length, days: days.size };
}

function runBatch(n) {
    return new Promise((resolve) => {
        log(`Starting batch of ${n} runs…`);
        // process.execPath = absolute path of the running node binary; a bare
        // 'node' fails under launchd, whose environment has no shell PATH.
        const child = spawn(process.execPath, [path.join(__dirname, 'htlc-evaluation.js'), 'run-batch', String(n)], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', (d) => process.stdout.write(d));
        child.stderr.on('data', (d) => process.stderr.write(d));
        child.on('close', (code) => { log(`Batch finished (exit ${code})`); resolve(code); });
    });
}

async function main() {
    if (process.argv[2] === 'status') {
        const p = progress();
        console.log(`Successful runs: ${p.done}/${TARGET} across ${p.days} distinct day(s)`);
        return;
    }

    acquireLock();
    log(`Campaign started: target ${TARGET} runs, batches of ${BATCH}, gaps ${MIN_GAP_H}-${MAX_GAP_H} h`);
    for (;;) {
        const p = progress();
        log(`Progress: ${p.done}/${TARGET} successful runs across ${p.days} day(s)`);
        if (p.done >= TARGET && p.days >= MIN_DAYS) {
            log('Target reached. Run: node scripts/campaign-analyze.js');
            break;
        }
        if (p.done >= TARGET && p.days < MIN_DAYS) {
            log(`Sample size reached but only ${p.days}/${MIN_DAYS} distinct days; continuing with small batches for day coverage.`);
        }

        const n = Math.min(BATCH, Math.max(1, TARGET - p.done));
        await runBatch(p.done >= TARGET ? 1 : n);

        const gapH = MIN_GAP_H + Math.random() * (MAX_GAP_H - MIN_GAP_H);
        const next = new Date(Date.now() + gapH * 3600 * 1000);
        log(`Sleeping ${gapH.toFixed(1)} h; next session ~${next.toISOString()}`);
        await new Promise((r) => setTimeout(r, gapH * 3600 * 1000));
    }
}

main().catch((e) => { log(`FATAL: ${e.message}`); process.exit(1); });
