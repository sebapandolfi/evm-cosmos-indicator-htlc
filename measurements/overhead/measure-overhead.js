// Measures the gas of lockForBurn with and without the semantic layer on a
// local fork of Polygon mainnet (real Axelar gateway and gas service).
const { ethers, network } = require('hardhat');
const GATEWAY = '0x6f015F16De9fC8791b234eF68D486d2bF203FBA8';
const GAS_SERVICE = '0x2d5d7d31F671F86C782533cc367F14109a082712';
const NEUTRON = 'neutron1d9k5ceh44555gxru06zk56cm8wd0hf683y77xncq9kmlzmaaxjyqgew60j';
const RECIP = 'neutron1n4ywn62cl3p6uzj0l8a66s3xsj7gg9qv78s8g7';

async function setup(name) {
  const [owner] = await ethers.getSigners();
  const Tok = await ethers.getContractFactory('IndicatorToken1155');
  const tok = await Tok.deploy('ipfs://x'); await tok.deployed();
  const Br = await ethers.getContractFactory(name);
  const br = await Br.deploy(GATEWAY, GAS_SERVICE, tok.address, 'Polygon'); await br.deployed();
  await (await tok.setBridge(br.address)).wait();
  const ph = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('test_indicator_profile_v1'));
  const dh = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('test_indicator_data_v1'));
  await (await tok.createTokenClass('CO2_REMOVAL', 'kgCO2e', 'test-methodology', ph, dh)).wait();
  await (await tok.mintInitialSupply(owner.address, 1, ethers.utils.parseEther('1000'))).wait();
  await (await tok.setApprovalForAll(br.address, true)).wait();
  return { br, tok };
}

async function lock(br, i) {
  const secret = ethers.utils.hexZeroPad(ethers.utils.hexlify(1000 + i), 32);
  const H = ethers.utils.keccak256(secret);
  const blk = await ethers.provider.getBlock('latest');
  const tl = blk.timestamp + 3900;
  const tx = await br.lockForBurn(1, ethers.utils.parseEther('1'), H, tl, RECIP, 'neutron', NEUTRON,
      ethers.utils.parseEther('0.1'), { value: ethers.utils.parseEther('1'), gasLimit: 2000000 });
  const r = await tx.wait();
  return { hash: tx.hash, gas: r.gasUsed.toNumber() };
}

function attribute(trace, addrs) {
  // callTracer output: sum gasUsed of top-level subcalls per target
  const out = {};
  for (const c of (trace.calls || [])) {
    const to = c.to.toLowerCase();
    const key = addrs[to] || to;
    out[key] = (out[key] || 0) + parseInt(c.gasUsed, 16);
  }
  out._total = parseInt(trace.gasUsed, 16);
  return out;
}

async function main() {
  console.log('fork block', (await ethers.provider.getBlockNumber()));
  const A = await setup('contracts/BridgeHTLC.sol:BridgeHTLC'.replace('contracts/', 'evm-contracts/'));
  const B = await setup('evm-contracts/BridgeHTLCNoSemantic.sol:BridgeHTLCNoSemantic');
  const rows = [];
  for (let i = 0; i < (process.env.REPS ? +process.env.REPS : 5); i++) {
    const a = await lock(A.br, i); const b = await lock(B.br, 100 + i);
    rows.push({ rep: i + 1, semantic: a.gas, noSemantic: b.gas, delta: a.gas - b.gas, ha: a.hash, hb: b.hash });
  }
  console.table(rows.map(r => ({ rep: r.rep, semantic: r.semantic, noSemantic: r.noSemantic, delta: r.delta })));
  // attribution with callTracer on rep 2 (warm storage, steady state)
  for (const [label, X, h] of [['semantic', A, rows[1].ha], ['noSemantic', B, rows[1].hb]]) {
    try {
      const tr = await network.provider.send('debug_traceTransaction', [h, { disableStorage: true, disableMemory: true, disableStack: false }]);
      const L = tr.structLogs; const res = {}; let callsGas = 0;
      for (let k = 0; k < L.length; k++) {
        const op = L[k];
        if (op.depth === 1 && ['CALL','STATICCALL','DELEGATECALL'].includes(op.op)) {
          const st = op.stack; const to = '0x' + st[st.length - 2].slice(-40);
          let j = k + 1; while (j < L.length && L[j].depth !== 1) j++;
          const used = op.gas - (j < L.length ? L[j].gas : 0);
          const key = ({ [GATEWAY.toLowerCase()]: 'gateway', [GAS_SERVICE.toLowerCase()]: 'gasService', [X.tok.address.toLowerCase()]: 'token' })[to.toLowerCase()] || to;
          res[key] = (res[key] || 0) + used; callsGas += used;
          res.ncalls = (res.ncalls || 0) + 1;
        }
      }
      res.total = tr.gas; res.bridgeOwn = tr.gas - callsGas;
      console.log(label, JSON.stringify(res));
    } catch (e) { console.log('trace failed', label, e.message.slice(0, 200)); }
  }
  require('fs').writeFileSync('overhead-results.json', JSON.stringify(rows, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
