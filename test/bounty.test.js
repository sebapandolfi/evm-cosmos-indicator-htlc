#!/usr/bin/env node
/**
 * Unit tests for the bountied-callback mechanism in BridgeHTLC.
 *
 * Run with:  npx hardhat run --no-compile test/bounty.test.js
 * (compile first with: node scripts/compile-local.js)
 *
 * Covers:
 *  T1  lockForBurn escrows bounty in the bridge, forwards the rest to the gas service
 *  T2  monitor claimBurn receives the bounty (incentive-compatible A4)
 *  T3  automatic callback (_execute) burns and returns bounty to the sender
 *  T4  refundBurn returns tokens AND bounty to the sender after timeout
 *  T5  reverting bounty recipient falls back to pendingWithdrawals (pull payment)
 *  T6  msg.value <= bounty reverts
 *  T7  invalid secret: claimBurn reverts; callback is ignored without state change
 *  T8  bounty = 0 preserves legacy behaviour
 *  T9  no double settlement: claim after claim/refund reverts
 */
const hre = require('hardhat');
const { ethers } = hre;
const fs = require('fs');
const path = require('path');

const ART = path.join(__dirname, '..', 'artifacts-local');
const art = (n) => JSON.parse(fs.readFileSync(path.join(ART, `${n}.json`), 'utf8'));

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log(`  ok   ${msg}`); }
    else { failed++; console.error(`  FAIL ${msg}`); }
}
async function expectRevert(promise, msg) {
    try { await promise; assert(false, `${msg} (did not revert)`); }
    catch (e) { assert(true, `${msg} (reverted: ${(e.reason || e.message).slice(0, 60)})`); }
}

async function deployAll(owner) {
    const F = (n, s) => new ethers.ContractFactory(art(n).abi, art(n).bytecode, s);
    const gateway = await F('MockAxelarGateway', owner).deploy();
    const gasService = await F('MockAxelarGasService', owner).deploy();
    const token = await F('IndicatorToken1155', owner).deploy('https://example.org/{id}.json');
    const bridge = await F('BridgeHTLC', owner).deploy(gateway.address, gasService.address, token.address, 'Polygon');
    await (await token.setBridge(bridge.address)).wait();
    await (await token.createTokenClass(
        'CO2_REMOVAL', 'kgCO2e', 'Verra-VM0007',
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes('profile-1')),
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes('evidence-1'))
    )).wait();
    return { gateway, gasService, token, bridge };
}

function newSecret() {
    const secret = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    return { secret, hashlock: ethers.utils.keccak256(secret) };
}

async function lock(bridge, user, hashlock, { bounty, value, tokenId = 1, amount = 1 }) {
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    return bridge.connect(user).lockForBurn(
        tokenId, amount, hashlock, now + 7200,
        'neutron1xyzabcdefexamplerecipient00000000000001',
        'neutron', 'neutron1contractaddressexample000000000000002',
        bounty, { value }
    );
}

async function main() {
    const [owner, user, monitor, rando] = await ethers.getSigners();
    const BOUNTY = ethers.utils.parseEther('0.2');
    const VALUE = ethers.utils.parseEther('1.0'); // 0.8 gas + 0.2 bounty

    // ---------------- T1: escrow split ----------------
    console.log('T1: lockForBurn escrows bounty, forwards remainder to gas service');
    let { gateway, gasService, token, bridge } = await deployAll(owner);
    await (await token.mintInitialSupply(user.address, 1, 100)).wait();
    await (await token.connect(user).setApprovalForAll(bridge.address, true)).wait();

    let s1 = newSecret();
    await (await lock(bridge, user, s1.hashlock, { bounty: BOUNTY, value: VALUE })).wait();
    assert((await ethers.provider.getBalance(bridge.address)).eq(BOUNTY), 'bridge holds exactly the bounty');
    assert((await ethers.provider.getBalance(gasService.address)).eq(VALUE.sub(BOUNTY)), 'gas service received msg.value - bounty');
    const lk = await bridge.getLock(s1.hashlock);
    assert(lk.bounty.eq(BOUNTY) && lk.state === 1, 'lock stores bounty, state LOCKED');
    assert((await token.balanceOf(bridge.address, 1)).eq(1), 'tokens escrowed');

    // ---------------- T2: monitor gets the bounty ----------------
    console.log('T2: third-party claimBurn receives the bounty');
    const balBefore = await monitor.getBalance();
    const rcpt = await (await bridge.connect(monitor).claimBurn(s1.hashlock, s1.secret)).wait();
    const gasCost = rcpt.gasUsed.mul(rcpt.effectiveGasPrice);
    const balAfter = await monitor.getBalance();
    assert(balAfter.sub(balBefore).add(gasCost).eq(BOUNTY), 'monitor net gain equals bounty');
    assert((await token.balanceOf(bridge.address, 1)).eq(0), 'escrow burned');
    assert((await ethers.provider.getBalance(bridge.address)).eq(0), 'bridge escrow emptied');
    const bountyEvt = rcpt.events.find((e) => e.event === 'BountyPaid');
    assert(bountyEvt && bountyEvt.args.recipient === monitor.address && !bountyEvt.args.credited, 'BountyPaid(monitor, direct)');

    // ---------------- T3: automatic callback returns bounty to sender ----------------
    console.log('T3: automatic callback burns and returns bounty to sender');
    let s2 = newSecret();
    await (await lock(bridge, user, s2.hashlock, { bounty: BOUNTY, value: VALUE })).wait();
    const userBal = await user.getBalance();
    const payload = ethers.utils.defaultAbiCoder.encode(['bytes32', 'bytes32'], [s2.hashlock, s2.secret]);
    // rando delivers the approved message (mock gateway approves everything)
    const r3 = await (await bridge.connect(rando).execute(
        ethers.utils.formatBytes32String('cmd-1'), 'neutron', 'neutron1contractaddressexample000000000000002', payload
    )).wait();
    assert((await user.getBalance()).sub(userBal).eq(BOUNTY), 'sender got the bounty back');
    assert((await bridge.getLock(s2.hashlock)).state === 2, 'lock CLAIMED via callback');
    assert(r3.events.some((e) => e.event === 'CallbackBurnProcessed'), 'CallbackBurnProcessed emitted');

    // ---------------- T4: refund returns tokens + bounty ----------------
    console.log('T4: refundBurn returns tokens and bounty after timeout');
    let s3 = newSecret();
    await (await lock(bridge, user, s3.hashlock, { bounty: BOUNTY, value: VALUE })).wait();
    await hre.network.provider.send('evm_increaseTime', [7300]);
    await hre.network.provider.send('evm_mine');
    const ub4 = await user.getBalance();
    const r4 = await (await bridge.connect(user).refundBurn(s3.hashlock)).wait();
    const g4 = r4.gasUsed.mul(r4.effectiveGasPrice);
    assert((await user.getBalance()).sub(ub4).add(g4).eq(BOUNTY), 'sender recovered the bounty');
    assert((await token.balanceOf(user.address, 1)).eq(98), 'tokens returned (100 minted - 3 locked + 1 refund)');

    // ---------------- T5: pull-payment fallback ----------------
    console.log('T5: reverting recipient credits pendingWithdrawals');
    const MonitorF = new ethers.ContractFactory(art('TogglableMonitor').abi, art('TogglableMonitor').bytecode, owner);
    const badMonitor = await MonitorF.deploy(); // acceptFunds defaults false
    let s5 = newSecret();
    await (await lock(bridge, user, s5.hashlock, { bounty: BOUNTY, value: VALUE })).wait();
    await (await badMonitor.doClaim(bridge.address, s5.hashlock, s5.secret)).wait();
    assert((await bridge.pendingWithdrawals(badMonitor.address)).eq(BOUNTY), 'bounty credited to pendingWithdrawals');
    await (await badMonitor.setAccept(true)).wait();
    await (await badMonitor.doWithdraw(bridge.address)).wait();
    assert((await ethers.provider.getBalance(badMonitor.address)).eq(BOUNTY), 'withdrawPending paid out');
    assert((await bridge.pendingWithdrawals(badMonitor.address)).eq(0), 'pendingWithdrawals cleared');

    // ---------------- T6: msg.value must exceed bounty ----------------
    console.log('T6: msg.value <= bounty reverts');
    let s6 = newSecret();
    await expectRevert(lock(bridge, user, s6.hashlock, { bounty: VALUE, value: VALUE }), 'value == bounty rejected');

    // ---------------- T7: invalid secret ----------------
    console.log('T7: invalid secrets rejected without state change');
    let s7 = newSecret();
    await (await lock(bridge, user, s7.hashlock, { bounty: BOUNTY, value: VALUE })).wait();
    const wrong = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    await expectRevert(bridge.connect(monitor).claimBurn(s7.hashlock, wrong), 'claimBurn with wrong secret');
    const badPayload = ethers.utils.defaultAbiCoder.encode(['bytes32', 'bytes32'], [s7.hashlock, wrong]);
    const r7 = await (await bridge.connect(rando).execute(
        ethers.utils.formatBytes32String('cmd-2'), 'neutron', 'neutron1contractaddressexample000000000000002', badPayload
    )).wait();
    assert(r7.events.some((e) => e.event === 'CallbackIgnored'), 'callback with wrong secret ignored');
    assert((await bridge.getLock(s7.hashlock)).state === 1, 'lock still LOCKED');
    await (await bridge.connect(monitor).claimBurn(s7.hashlock, s7.secret)).wait(); // cleanup, monitor collects

    // ---------------- T8: protocol-minimum bounty ----------------
    console.log('T8: minimum bounty enforced; owner can adjust the floor');
    let s8 = newSecret();
    await expectRevert(lock(bridge, user, s8.hashlock, { bounty: 0, value: VALUE }), 'zero bounty rejected');
    await expectRevert(lock(bridge, user, s8.hashlock, { bounty: ethers.utils.parseEther('0.01'), value: VALUE }), 'sub-minimum bounty rejected');
    assert((await bridge.minBounty()).eq(ethers.utils.parseEther('0.05')), 'default minBounty is 0.05');
    await expectRevert(bridge.connect(user).setMinBounty(0), 'non-owner cannot set minBounty');
    await (await bridge.connect(owner).setMinBounty(0)).wait();
    await (await lock(bridge, user, s8.hashlock, { bounty: 0, value: VALUE })).wait();
    const r8 = await (await bridge.connect(monitor).claimBurn(s8.hashlock, s8.secret)).wait();
    assert(!r8.events.some((e) => e.event === 'BountyPaid'), 'no BountyPaid for zero bounty once floor lowered');
    await (await bridge.connect(owner).setMinBounty(ethers.utils.parseEther('0.05'))).wait();

    // ---------------- T9: no double settlement ----------------
    console.log('T9: settled locks cannot be claimed or refunded again');
    await expectRevert(bridge.connect(monitor).claimBurn(s8.hashlock, s8.secret), 'double claim rejected');
    await expectRevert(bridge.connect(user).refundBurn(s8.hashlock), 'refund after claim rejected');

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
