#!/usr/bin/env node
/**
 * Unit tests for the reverse direction (Cosmos -> EVM): BridgeHTLC acting as
 * the HTLC destination.
 *
 * Run with:  npx hardhat run --no-compile test/reverse.test.js
 * (compile first with: node scripts/compile-local.js)
 *
 * R1  authorized prepare-mint message creates a PENDING mint
 * R2  unauthorized source is ignored without state change
 * R3  unregistered class / identity mismatch are ignored (semantic check)
 * R4  claimMint verifies the secret, mints to recipient, emits the burn
 *     callback (JSON claim_burn) through the gateway
 * R5  claimMint with wrong secret / after timeout reverts
 * R6  refundMint frees the hashlock after timeout, not before
 * R7  duplicate hashlock (existing pending mint or forward lock) is ignored
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
    catch (e) { assert(true, `${msg} (reverted)`); }
}

const NEUTRON_CHAIN = 'neutron';
const NEUTRON_ADDR = 'neutron1contractaddressexample000000000000002';
const TAG = 2; // MSG_PREPARE_MINT

function encodePrepare({ hashlock, indicatorId, tokenId, amount, recipient, timeout }) {
    return ethers.utils.defaultAbiCoder.encode(
        ['uint256', 'bytes32', 'bytes32', 'uint256', 'uint256', 'address', 'uint256'],
        [TAG, hashlock, indicatorId, tokenId, amount, recipient, timeout]
    );
}

function newSecret() {
    const secret = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    return { secret, hashlock: ethers.utils.keccak256(secret) };
}

async function main() {
    const [owner, user, rando] = await ethers.getSigners();
    const F = (n, s) => new ethers.ContractFactory(art(n).abi, art(n).bytecode, s);

    const gateway = await F('MockAxelarGateway', owner).deploy();
    const gasService = await F('MockAxelarGasService', owner).deploy();
    const token = await F('IndicatorToken1155', owner).deploy('https://example.org/{id}.json');
    const bridge = await F('BridgeHTLC', owner).deploy(gateway.address, gasService.address, token.address, 'Polygon');
    await (await token.setBridge(bridge.address)).wait();
    const profileHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('profile-1'));
    await (await token.createTokenClass('CO2_REMOVAL', 'kgCO2e', 'Verra-VM0007', profileHash,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes('evidence-1')))).wait();
    const indicatorId = ethers.utils.keccak256(profileHash);
    await (await bridge.setAuthorizedSource(NEUTRON_CHAIN, NEUTRON_ADDR)).wait();

    const now = async () => (await ethers.provider.getBlock('latest')).timestamp;
    const exec = (signer, chain, addr, payload, cmd) =>
        bridge.connect(signer).execute(ethers.utils.formatBytes32String(cmd), chain, addr, payload);

    // ---------------- R1 ----------------
    console.log('R1: authorized prepare-mint creates PENDING mint');
    const s1 = newSecret();
    const t1 = (await now()) + 1800; // T_c = 30 min
    const r1 = await (await exec(rando, NEUTRON_CHAIN, NEUTRON_ADDR,
        encodePrepare({ hashlock: s1.hashlock, indicatorId, tokenId: 1, amount: 5, recipient: user.address, timeout: t1 }), 'r1')).wait();
    assert(r1.events.some((e) => e.event === 'MintPrepared'), 'MintPrepared emitted');
    const pm1 = await bridge.getPendingMint(s1.hashlock);
    assert(pm1.state === 1 && pm1.amount.eq(5) && pm1.recipient === user.address, 'pending mint stored');

    // ---------------- R2 ----------------
    console.log('R2: unauthorized source ignored');
    const s2 = newSecret();
    const r2 = await (await exec(rando, 'osmosis', 'osmo1someotheraddress0000000000000000000001',
        encodePrepare({ hashlock: s2.hashlock, indicatorId, tokenId: 1, amount: 5, recipient: user.address, timeout: t1 }), 'r2')).wait();
    assert(r2.events.some((e) => e.event === 'CallbackIgnored'), 'CallbackIgnored emitted');
    assert((await bridge.getPendingMint(s2.hashlock)).state === 0, 'no state created');

    // ---------------- R3 ----------------
    console.log('R3: unregistered class and identity mismatch ignored');
    const s3a = newSecret();
    const r3a = await (await exec(rando, NEUTRON_CHAIN, NEUTRON_ADDR,
        encodePrepare({ hashlock: s3a.hashlock, indicatorId, tokenId: 99, amount: 5, recipient: user.address, timeout: t1 }), 'r3a')).wait();
    assert(r3a.events.some((e) => e.event === 'CallbackIgnored'), 'unregistered tokenId ignored');
    const s3b = newSecret();
    const wrongId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('other-profile'));
    const r3b = await (await exec(rando, NEUTRON_CHAIN, NEUTRON_ADDR,
        encodePrepare({ hashlock: s3b.hashlock, indicatorId: wrongId, tokenId: 1, amount: 5, recipient: user.address, timeout: t1 }), 'r3b')).wait();
    assert(r3b.events.some((e) => e.event === 'CallbackIgnored'), 'indicatorId mismatch ignored');

    // ---------------- R4 ----------------
    console.log('R4: claimMint mints and emits burn callback');
    const balBefore = await token.balanceOf(user.address, 1);
    const r4 = await (await bridge.connect(user).claimMint(s1.hashlock, s1.secret, { value: ethers.utils.parseEther('0.5') })).wait();
    assert((await token.balanceOf(user.address, 1)).sub(balBefore).eq(5), '5 tokens minted to recipient');
    assert((await bridge.getPendingMint(s1.hashlock)).state === 2, 'state MINTED');
    // Gateway received the callback with the claim_burn JSON
    const callEvt = (await gateway.queryFilter(gateway.filters.ContractCall())).pop();
    const payloadBytes = ethers.utils.arrayify(callEvt.args.payload);
    const json = ethers.utils.toUtf8String(payloadBytes.slice(4)); // skip version prefix
    assert(callEvt.args.destinationChain === NEUTRON_CHAIN, 'callback routed to neutron');
    assert(json.includes('"claim_burn"') && json.includes(s1.secret), 'claim_burn JSON carries the secret');
    assert((await ethers.provider.getBalance(gasService.address)).eq(ethers.utils.parseEther('0.5')), 'callback gas prepaid');

    // ---------------- R5 ----------------
    console.log('R5: wrong secret / expired window revert');
    const s5 = newSecret();
    const t5 = (await now()) + 900;
    await (await exec(rando, NEUTRON_CHAIN, NEUTRON_ADDR,
        encodePrepare({ hashlock: s5.hashlock, indicatorId, tokenId: 1, amount: 1, recipient: user.address, timeout: t5 }), 'r5')).wait();
    await expectRevert(bridge.connect(user).claimMint(s5.hashlock, ethers.utils.hexlify(ethers.utils.randomBytes(32))), 'wrong secret');
    await hre.network.provider.send('evm_increaseTime', [1000]);
    await hre.network.provider.send('evm_mine');
    await expectRevert(bridge.connect(user).claimMint(s5.hashlock, s5.secret), 'claim after T_c');

    // ---------------- R6 ----------------
    console.log('R6: refundMint after timeout only');
    await (await bridge.connect(rando).refundMint(s5.hashlock)).wait();
    assert((await bridge.getPendingMint(s5.hashlock)).state === 3, 'state REFUNDED');
    const s6 = newSecret();
    const t6 = (await now()) + 1800;
    await (await exec(rando, NEUTRON_CHAIN, NEUTRON_ADDR,
        encodePrepare({ hashlock: s6.hashlock, indicatorId, tokenId: 1, amount: 1, recipient: user.address, timeout: t6 }), 'r6')).wait();
    await expectRevert(bridge.connect(rando).refundMint(s6.hashlock), 'refund before T_c rejected');

    // ---------------- R7 ----------------
    console.log('R7: duplicate hashlock ignored');
    const r7 = await (await exec(rando, NEUTRON_CHAIN, NEUTRON_ADDR,
        encodePrepare({ hashlock: s6.hashlock, indicatorId, tokenId: 1, amount: 7, recipient: rando.address, timeout: t6 }), 'r7')).wait();
    assert(r7.events.some((e) => e.event === 'CallbackIgnored'), 'duplicate prepare ignored');
    assert((await bridge.getPendingMint(s6.hashlock)).amount.eq(1), 'original pending mint untouched');

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
