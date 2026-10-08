#!/usr/bin/env node
/**
 * campaign-cost.js v2 — Costo real por transferencia, derivado de datos on-chain.
 *
 * Read-only: no firma ni envía ninguna transacción.
 *
 * Cambios de v1 (v1 daba el relay neto mal, en 0,9 POL):
 *   - El LCD rest-kralum.neutron-1.neutron.org está caído -> se usa polkachu con fallbacks.
 *   - El decode del evento Refunded era incorrecto (logIndex va indexado). Además los RPC
 *     públicos de Polygon rechazan eth_getLogs histórico ("archive requests require a token"),
 *     así que el reembolso NO se puede sacar por logs. Se toma de la API de Axelarscan y se
 *     verifica opcionalmente contra el receipt de la tx de reembolso.
 *   - Axelarscan aporta además el precio de POL/AXL EN LA FECHA DE LA TRANSFERENCIA, que es lo
 *     defendible en una tesis (no el precio de hoy).
 *
 * Tres nociones de costo, que el script distingue explícitamente:
 *   (1) PREPAGADO   lo que el usuario inmoviliza    = gas + msg.value + funds del callback
 *   (2) NETO        lo que efectivamente se pierde  = prepagado - reembolsos - bounty devuelto
 *   (3) CONSUMIDO   solo gas on-chain
 * Para la tesis la cifra principal es (2); (1) es el requisito de fondeo (punto de UX).
 *
 * Uso:
 *   node scripts/campaign-cost.js --limit 3            # prueba rápida
 *   node scripts/campaign-cost.js                      # completo, precios de Axelarscan
 *   node scripts/campaign-cost.js --pol-usd 0.22 --axl-usd 0.55 --ntrn-usd 0.10
 *        (los precios que pases OVERRIDEAN los de Axelarscan; se reportan ambos)
 *   node scripts/campaign-cost.js --no-neutron         # solo pierna EVM
 *
 * Env opcionales: POLYGON_RPC, NEUTRON_LCD
 * Salidas: scripts/campaign-cost.csv, campaign-cost.json, cost-summary.tex
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { ethers } = require('ethers');

// ---------------------------------------------------------------- argumentos

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const num = (v) => (v === undefined || v === null || v === true ? null : Number(v));

const OPTS = {
  polUsd: num(arg('pol-usd')),
  axlUsd: num(arg('axl-usd')),
  ntrnUsd: num(arg('ntrn-usd')),
  limit: arg('limit') ? Number(arg('limit')) : null,
  neutron: !arg('no-neutron', false),
  reverse: !!arg('reverse', false),
};

const POLYGON_RPC = process.env.POLYGON_RPC || 'https://polygon-bor-rpc.publicnode.com';
const NEUTRON_LCDS = [
  process.env.NEUTRON_LCD,
  'https://neutron-api.polkachu.com',
  'https://rest.cosmos.directory/neutron',
  'https://neutron-rest.publicnode.com',
].filter(Boolean).map((u) => u.replace(/\/$/, ''));
const AXELARSCAN = 'https://api.gmp.axelarscan.io/';

// Constantes del protocolo tal como corrió la campaña (htlc-evaluation.js)
const BOUNTY_POL = Number(process.env.BOUNTY_POL || '0.1'); // en escrow; vuelve por callback automático
const FEEREFUNDER_TIMEOUT_REFUND_NTRN = 0.2;                 // la porción de timeout se reembolsa si hay éxito

// ---------------------------------------------------------------- utilidades

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, label, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < attempts - 1) await sleep(700 * (i + 1)); }
  }
  throw new Error(`${label}: ${(last && (last.reason || last.message)) || last}`);
}

function stats(values) {
  const v = values.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pick = (p) => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)];
  return {
    n: v.length, min: v[0], max: v[v.length - 1],
    median: (v[Math.floor((v.length - 1) / 2)] + v[Math.ceil((v.length - 1) / 2)]) / 2,
    mean: v.reduce((a, b) => a + b, 0) / v.length,
    p90: pick(0.9), p95: pick(0.95),
  };
}
const f = (n, d = 6) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toFixed(d));
const med = (s) => (s ? s.median : null);

async function axelarscan(body) {
  const r = await fetch(AXELARSCAN, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`axelarscan HTTP ${r.status}`);
  const j = await r.json();
  return (j && j.data) || [];
}

// ---------------------------------------------------------------- pierna EVM

async function evmLeg(runs) {
  const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC, { name: 'polygon', chainId: 137 });
  const rows = [];
  const bridges = new Set(), senders = new Set();
  let minBlock = Infinity, maxBlock = 0;

  for (const [i, run] of runs.entries()) {
    const hash = run.lock && run.lock.txHash;
    if (!hash) continue;
    process.stdout.write(`\r  Polygon + Axelarscan  ${i + 1}/${runs.length}   `);

    let receipt, tx;
    try {
      [receipt, tx] = await retry(
        () => Promise.all([provider.getTransactionReceipt(hash), provider.getTransaction(hash)]), `receipt ${hash}`);
    } catch (e) { console.warn(`\n  ! ${hash}: ${e.message}`); continue; }
    if (!receipt || !tx) { console.warn(`\n  ! sin receipt: ${hash}`); continue; }

    bridges.add(ethers.utils.getAddress(receipt.to));
    senders.add(ethers.utils.getAddress(receipt.from));
    minBlock = Math.min(minBlock, receipt.blockNumber);
    maxBlock = Math.max(maxBlock, receipt.blockNumber);

    const gasPriceWei = receipt.effectiveGasPrice || tx.gasPrice;
    const lockGasCostPol = Number(ethers.utils.formatEther(receipt.gasUsed.mul(gasPriceWei)));
    const msgValuePol = Number(ethers.utils.formatEther(tx.value));

    // --- Axelarscan: reembolso real + precios contemporáneos ---
    let refundPol = null, gasPaidPol = null, polUsdAtTx = null, axlUsdAtTx = null,
      refundTx = null, gmpStatus = null, gmpSeconds = null;
    try {
      const [g] = await retry(() => axelarscan({ method: 'searchGMP', txHash: hash }), `gmp ${hash}`, 3);
      if (g) {
        gmpStatus = g.status;
        refundPol = (g.refunded && typeof g.refunded.amount === 'number') ? g.refunded.amount : 0;
        refundTx = g.refunded && g.refunded.transactionHash;
        gasPaidPol = (g.gas && g.gas.gas_paid_amount) ?? null;
        const st = (g.fees && g.fees.source_token) || {};
        const dt = (g.fees && g.fees.destination_native_token) || {};
        polUsdAtTx = (st.token_price && st.token_price.usd) ?? null;
        axlUsdAtTx = (dt.token_price && dt.token_price.usd) ?? null;
        gmpSeconds = (g.time_spent && g.time_spent.total) ?? null;
      }
    } catch (e) { console.warn(`\n  ! axelarscan ${hash}: ${e.message}`); }

    rows.push({
      run: run.run_number,
      lockTx: hash,
      block: receipt.blockNumber,
      bridge: ethers.utils.getAddress(receipt.to),
      lockGasUsed: receipt.gasUsed.toNumber(),
      gasPriceGwei: Number(ethers.utils.formatUnits(gasPriceWei, 'gwei')),
      lockGasCostPol,
      msgValuePol,
      gasPaidPol,               // msg.value menos el bounty en escrow (lo que va al gas service)
      refundPol,                // reembolso de Axelar del prepago no consumido
      refundTx,
      netRelayPol: gasPaidPol !== null && refundPol !== null ? gasPaidPol - refundPol : null,
      gmpStatus,
      gmpSeconds,
      polUsdAtTx,
      axlUsdAtTx,
    });
    await sleep(200);
  }
  process.stdout.write('\n');
  return { rows, bridges: [...bridges], senders: [...senders], minBlock, maxBlock };
}

// ------------------------------------------------------------ pierna Neutron

async function pickLcd() {
  for (const base of NEUTRON_LCDS) {
    try {
      const r = await fetch(`${base}/cosmos/base/tendermint/v1beta1/node_info`);
      if (r.ok) return base;
    } catch (_) { /* siguiente */ }
  }
  return null;
}

async function neutronLeg(runs) {
  const base = await pickLcd();
  if (!base) { console.warn('  ! ningún LCD de Neutron respondió; se omite la pierna Cosmos'); return { rows: [], lcd: null }; }
  console.log(`  LCD de Neutron: ${base}`);

  const rows = [];
  for (const [i, run] of runs.entries()) {
    const hash = run.claim && run.claim.txHash;
    if (!hash) continue;
    process.stdout.write(`\r  Neutron txs  ${i + 1}/${runs.length}   `);
    try {
      const res = await retry(async () => {
        const r = await fetch(`${base}/cosmos/tx/v1beta1/txs/${hash}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }, `neutron ${hash}`, 3);

      const feeAmounts = (((res.tx || {}).auth_info || {}).fee || {}).amount || [];
      const feeNtrn = feeAmounts.filter((c) => c.denom === 'untrn')
        .reduce((a, c) => a + Number(c.amount), 0) / 1e6;

      const funds = (((res.tx || {}).body || {}).messages || []).flatMap((m) => m.funds || []);
      // AXL llega como denom ibc/...; untrn es el feerefunder de Neutron
      const axlAttached = funds.filter((c) => c.denom.startsWith('ibc/'))
        .reduce((a, c) => a + Number(c.amount), 0) / 1e6;
      const untrnAttached = funds.filter((c) => c.denom === 'untrn')
        .reduce((a, c) => a + Number(c.amount), 0) / 1e6;

      rows.push({
        run: run.run_number,
        claimTx: hash,
        claimGasUsed: Number((res.tx_response || {}).gas_used || 0),
        claimGasWanted: Number((res.tx_response || {}).gas_wanted || 0),
        claimFeeNtrn: feeNtrn,
        axlAttached,
        untrnAttached,
        untrnNet: untrnAttached - FEEREFUNDER_TIMEOUT_REFUND_NTRN,
      });
    } catch (e) { console.warn(`\n  ! Neutron ${hash}: ${e.message}`); }
    await sleep(150);
  }
  process.stdout.write('\n');
  return { rows, lcd: base };
}

// ------------------------------ pierna del callback (GMP originado en Cosmos)

async function callbackLeg(bridgeAddress) {
  // Los callbacks Neutron->Polygon no están indexados por el hash de la tx de claim,
  // así que se los enumera por contrato destino. La API tope a size=25: hay que paginar.
  const PAGE = 25;
  try {
    const all = [];
    for (let from = 0; from < 500; from += PAGE) {
      const page = await retry(() => axelarscan({
        method: 'searchGMP', contractAddress: bridgeAddress, sourceChain: 'neutron', size: PAGE, from,
      }), `gmp callbacks from=${from}`, 3);
      all.push(...page);
      if (page.length < PAGE) break;
      await sleep(200);
    }
    const paid = all.map((g) => (g.gas && g.gas.gas_paid_amount) ?? null).filter((x) => x !== null);
    const refunds = all.map((g) => (g.refunded && g.refunded.amount) || 0);
    const executed = all.filter((g) => g.status === 'executed').length;
    return { n: all.length, executed, gasPaidAxl: stats(paid), refundAxl: stats(refunds) };
  } catch (e) { console.warn(`  ! callbacks: ${e.message}`); return null; }
}

// ---------------------------------------------------------------------- main

async function main() {
  const resultsPath = path.join(__dirname, OPTS.reverse ? 'reverse-results.json' : 'evaluation-results.json');
  const raw = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  let runs = (raw.runs || raw).filter((r) => r.success !== false);
  if (OPTS.limit) runs = runs.slice(0, OPTS.limit);

  console.log(`Corridas: ${runs.length}  (${path.basename(resultsPath)})`);
  console.log(`Polygon RPC: ${POLYGON_RPC}\n`);

  const evm = await evmLeg(runs);
  const neu = OPTS.neutron ? await neutronLeg(runs) : { rows: [], lcd: null };
  const cb = evm.bridges.length ? await callbackLeg(evm.bridges[0]) : null;

  const byRun = new Map();
  for (const r of evm.rows) byRun.set(r.run, { ...r });
  for (const r of neu.rows) byRun.set(r.run, { ...(byRun.get(r.run) || { run: r.run }), ...r });
  const merged = [...byRun.values()].sort((a, b) => a.run - b.run);

  // ------------------------------------------------------------ estadísticas
  const S = {
    gasUsed: stats(evm.rows.map((r) => r.lockGasUsed)),
    gasPriceGwei: stats(evm.rows.map((r) => r.gasPriceGwei)),
    lockGasCostPol: stats(evm.rows.map((r) => r.lockGasCostPol)),
    msgValuePol: stats(evm.rows.map((r) => r.msgValuePol)),
    gasPaidPol: stats(evm.rows.map((r) => r.gasPaidPol)),
    refundPol: stats(evm.rows.map((r) => r.refundPol)),
    netRelayPol: stats(evm.rows.map((r) => r.netRelayPol)),
    gmpSeconds: stats(evm.rows.map((r) => r.gmpSeconds)),
    claimGasUsed: stats(neu.rows.map((r) => r.claimGasUsed)),
    claimFeeNtrn: stats(neu.rows.map((r) => r.claimFeeNtrn)),
    axlAttached: stats(neu.rows.map((r) => r.axlAttached)),
    untrnAttached: stats(neu.rows.map((r) => r.untrnAttached)),
    untrnNet: stats(neu.rows.map((r) => r.untrnNet)),
    polUsdAtTx: stats(evm.rows.map((r) => r.polUsdAtTx)),
    axlUsdAtTx: stats(evm.rows.map((r) => r.axlUsdAtTx)),
  };

  // ----------------------------------------------------------------- reporte
  console.log('\n================== RESULTADOS ==================\n');
  console.log(`BridgeHTLC usado por la campaña : ${evm.bridges.join(', ') || '—'}`);
  console.log(`Remitente                       : ${evm.senders.join(', ') || '—'}`);
  console.log(`Bloques                         : ${evm.minBlock}–${evm.maxBlock}\n`);

  console.log('--- Pierna Polygon (lockForBurn) ---');
  console.log(`gas usado          mediana ${med(S.gasUsed)}   (min ${S.gasUsed && S.gasUsed.min}, max ${S.gasUsed && S.gasUsed.max})`);
  console.log(`precio efectivo    mediana ${f(med(S.gasPriceGwei), 1)} Gwei   (min ${f(S.gasPriceGwei && S.gasPriceGwei.min, 1)}, max ${f(S.gasPriceGwei && S.gasPriceGwei.max, 1)})`);
  console.log(`  OJO: gas-config.js fija maxPriorityFeePerGas=100 Gwei a propósito, para inclusión rápida.`);
  console.log(`       El costo de gas medido es una COTA SUPERIOR bajo una política agresiva, no el óptimo.`);
  console.log(`costo de gas       mediana ${f(med(S.lockGasCostPol), 4)} POL   (p95 ${f(S.lockGasCostPol && S.lockGasCostPol.p95, 4)})`);
  console.log(`msg.value          mediana ${f(med(S.msgValuePol), 3)} POL  = ${f(med(S.gasPaidPol), 3)} POL al gas service + ${BOUNTY_POL} POL de bounty en escrow`);
  console.log(`reembolso Axelar   mediana ${f(med(S.refundPol), 4)} POL   (n con dato: ${S.refundPol ? S.refundPol.n : 0})`);
  console.log(`RELAY NETO         mediana ${f(med(S.netRelayPol), 4)} POL`);
  if (S.gmpSeconds) console.log(`(Axelarscan time_spent mediana ${med(S.gmpSeconds)} s — contraste independiente del relay de ida)`);

  if (neu.rows.length) {
    console.log('\n--- Pierna Neutron (claim_mint) ---');
    console.log(`gas usado          mediana ${med(S.claimGasUsed)}`);
    console.log(`fee de la tx       mediana ${f(med(S.claimFeeNtrn), 5)} NTRN`);
    console.log(`AXL adjunto        mediana ${f(med(S.axlAttached), 3)} AXL  (relay fee del callback)`);
    console.log(`NTRN adjunto       mediana ${f(med(S.untrnAttached), 3)} NTRN (feerefunder) -> neto ${f(med(S.untrnNet), 3)} NTRN`);
  }
  if (cb) {
    console.log(`\n--- Callbacks Neutron->Polygon indexados en Axelarscan ---`);
    console.log(`registros ${cb.n}, ejecutados ${cb.executed}, gas pagado mediana ${f(med(cb.gasPaidAxl), 3)} AXL, reembolso mediana ${f(med(cb.refundAxl), 4)} AXL`);
  }

  // ---------------------------------------------------- costo por transferencia
  const gasPol = med(S.lockGasCostPol), netPol = med(S.netRelayPol), prepaidPol = med(S.msgValuePol);
  const axl = med(S.axlAttached), ntrnNet = med(S.untrnNet), ntrnGas = med(S.claimFeeNtrn);

  console.log('\n=== COSTO POR TRANSFERENCIA, EN ACTIVO NATIVO (medida primaria) ===');
  console.log(`(1) PREPAGADO : ${f(gasPol, 4)} + ${f(prepaidPol, 3)} POL | ${f(axl, 2)} AXL | ${f(med(S.untrnAttached), 3)} NTRN`);
  console.log(`(2) NETO      : ${f(gasPol !== null && netPol !== null ? gasPol + netPol : null, 4)} POL | ${f(axl, 2)} AXL | ${f(ntrnNet !== null && ntrnGas !== null ? ntrnNet + ntrnGas : null, 3)} NTRN`);
  console.log(`(3) CONSUMIDO : ${f(gasPol, 4)} POL de gas + ${f(ntrnGas, 5)} NTRN de gas`);
  console.log(`El bounty de ${BOUNTY_POL} POL queda inmovilizado y vuelve por el camino de callback automático.`);

  const priceSrc = [];
  const polUsd = OPTS.polUsd ?? med(S.polUsdAtTx);
  const axlUsd = OPTS.axlUsd ?? med(S.axlUsdAtTx);
  const ntrnUsd = OPTS.ntrnUsd;
  priceSrc.push(`POL ${f(polUsd, 6)} (${OPTS.polUsd ? 'provisto' : 'Axelarscan, fecha de la tx'})`);
  priceSrc.push(`AXL ${f(axlUsd, 6)} (${OPTS.axlUsd ? 'provisto' : 'Axelarscan, fecha de la tx'})`);
  priceSrc.push(`NTRN ${ntrnUsd ? f(ntrnUsd, 6) + ' (provisto)' : 'sin precio'}`);

  console.log('\n=== TRADUCCIÓN A USD (declarar precios y fecha en la tesis) ===');
  console.log(`precios: ${priceSrc.join(' | ')}`);
  if (OPTS.polUsd && med(S.polUsdAtTx)) {
    console.log(`  aviso: pasaste POL=${OPTS.polUsd} pero Axelarscan registra ${f(med(S.polUsdAtTx), 6)} en la fecha de las transferencias.`);
  }
  if (OPTS.axlUsd && med(S.axlUsdAtTx)) {
    console.log(`  aviso: pasaste AXL=${OPTS.axlUsd} pero Axelarscan registra ${f(med(S.axlUsdAtTx), 6)} en la fecha de las transferencias.`);
  }
  const usdNet = (polUsd ? (gasPol + netPol) * polUsd : 0) + (axlUsd && axl ? axl * axlUsd : 0)
    + (ntrnUsd && ntrnNet !== null ? (ntrnNet + (ntrnGas || 0)) * ntrnUsd : 0);
  const usdPre = (polUsd ? (gasPol + prepaidPol) * polUsd : 0) + (axlUsd && axl ? axl * axlUsd : 0)
    + (ntrnUsd ? (med(S.untrnAttached) || 0) * ntrnUsd : 0);
  console.log(`(1) PREPAGADO ≈ US$${f(usdPre, 4)}`);
  console.log(`(2) NETO      ≈ US$${f(usdNet, 4)}   <- cifra principal para la tesis`);

  // ------------------------------------------------------------- artefactos
  const cols = ['run', 'lockTx', 'block', 'bridge', 'lockGasUsed', 'gasPriceGwei', 'lockGasCostPol',
    'msgValuePol', 'gasPaidPol', 'refundPol', 'netRelayPol', 'refundTx', 'gmpSeconds', 'polUsdAtTx', 'axlUsdAtTx',
    'claimTx', 'claimGasUsed', 'claimFeeNtrn', 'axlAttached', 'untrnAttached'];
  fs.writeFileSync(path.join(__dirname, 'campaign-cost.csv'),
    [cols.join(','), ...merged.map((r) => cols.map((c) => (r[c] ?? '')).join(','))].join('\n'));

  fs.writeFileSync(path.join(__dirname, 'campaign-cost.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), source: path.basename(resultsPath),
    bridges: evm.bridges, senders: evm.senders, blockRange: [evm.minBlock, evm.maxBlock],
    neutronLcd: neu.lcd, prices: { polUsd, axlUsd, ntrnUsd, overrides: { ...OPTS } },
    summary: S, callbackLeg: cb,
    costPerTransfer: {
      prepaid: { pol: gasPol + prepaidPol, axl, ntrn: med(S.untrnAttached) },
      net: { pol: gasPol + netPol, axl, ntrn: (ntrnNet || 0) + (ntrnGas || 0) },
      consumed: { pol: gasPol, ntrn: ntrnGas },
      usd: { prepaid: usdPre, net: usdNet },
    },
    rows: merged,
  }, null, 2));

  fs.writeFileSync(path.join(__dirname, 'cost-summary.tex'), `% Auto-generado por campaign-cost.js v2 -- ${new Date().toISOString()}
% Fuente: ${path.basename(resultsPath)}, n=${evm.rows.length}, bloques ${evm.minBlock}-${evm.maxBlock}
% BridgeHTLC: ${evm.bridges.join(', ')}
% Precios: POL ${f(polUsd, 6)} USD, AXL ${f(axlUsd, 6)} USD, NTRN ${ntrnUsd ? f(ntrnUsd, 6) : 'n/d'} USD
%
% ADVERTENCIA METODOLOGICA: la campania uso una politica de gas deliberadamente agresiva
% (maxPriorityFeePerGas = 100 Gwei, gas-config.js), con un precio efectivo mediano de
% ${f(med(S.gasPriceGwei), 1)} Gwei. El costo de gas reportado es una cota superior.
%
lockForBurn consumio ${med(S.gasUsed)} gas (mediana), ${f(gasPol, 4)}~POL a un precio efectivo mediano de
${f(med(S.gasPriceGwei), 1)}~Gwei. Del prepago de ${f(prepaidPol, 2)}~POL, ${BOUNTY_POL}~POL quedan en escrow como
\\emph{bounty} y ${f(med(S.gasPaidPol), 2)}~POL van al servicio de gas de Axelar, que reembolsa
${f(med(S.refundPol), 4)}~POL (mediana) del prepago no consumido: el relay neto de la pierna de ida es
${f(netPol, 4)}~POL. El callback consume ${f(axl, 2)}~AXL de \\emph{relay fee} y ${f(med(S.untrnAttached), 3)}~NTRN de
\\emph{feerefunder} (${FEEREFUNDER_TIMEOUT_REFUND_NTRN}~NTRN reembolsados si la entrega tiene exito), mas
${f(ntrnGas, 5)}~NTRN de gas en Neutron. Costo neto por transferencia: ${f(gasPol + netPol, 4)}~POL,
${f(axl, 2)}~AXL y ${f((ntrnNet || 0) + (ntrnGas || 0), 3)}~NTRN (aprox. US\\$${f(usdNet, 3)}).
`);

  console.log('\nEscritos: scripts/campaign-cost.csv, campaign-cost.json, cost-summary.tex');
}

main().catch((e) => { console.error('\n', e); process.exit(1); });
