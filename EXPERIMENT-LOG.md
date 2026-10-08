# Mainnet Experiment Log

Record of the mainnet deployments and of the induced or encountered failures
that preceded the evaluation campaign (July 5–23, 2026). Every event below
occurred on Polygon and Neutron mainnet and carries a verifiable transaction
hash. Campaign results are in `scripts/evaluation-results.json` (forward
direction) and `scripts/reverse-results.json` (reverse direction).

## Evaluated deployment (generation 7)

All 50 runs of the forward-direction campaign were executed against these
contracts.

| Component | Address / ID |
|---|---|
| IndicatorToken1155 (Polygon) | `0x3E784515e367507144CB3e664E6419Ea8aCD7040` |
| BridgeHTLC (Polygon) | `0x810B1CD48B50a8Ae6594C2ac46f6A5bFA9Ab5F6b` (min-bounty floor 0.05 POL) |
| token_bridge_receiver (Neutron, CosmWasm) | `neutron15zvjz96kqzqq9vnmp409j58wf6he4jhd5dtx9ntxsrm6wvnp5h5q72nvsz` (min bounty 0.05 NTRN) |
| Token class 1 `indicatorId` | `0x3b9a01121e0b51b2a111a19d3d8de8a3454a88a846c92694b06fddc3e0d9a2a6` (mirrored on both chains) |
| Axelar GMP account | `axelar1dv4u5k73pzqrxlzujxg3qp8kvc3pje7jtdvu72npnt5zhq05ejcsn5qme5` |
| Axelar relayer fee recipient | `axelar1aythygn6z5thymj6tmzfwekzh05ewg3l7d6y89` |
| IBC channel Neutron <-> Axelar | Neutron `channel-2` <-> Axelar `channel-78` |
| Authorized IBC-hook intermediary (channel-2) | `neutron1hnsm3z9azj6vyfsgkztdeys8rl0qqg96wmftv63yhuszalxfq6msqqjttm` |

## Earlier generations (audit trail)

| Generation | Contract | Address | Notes |
|---|---|---|---|
| Initial release | IndicatorToken1155 | `0x7Dbf7583c758e34D2CB4F3fd1E8C998E5469345a` | Callback signalled by event attributes; burn submitted off-chain |
| Initial release | BridgeHTLC | `0x078154e912A94f57be962A7B3926dbcaF0eD27e0` | |
| Initial release | Receiver | `neutron1d9k5ceh44555gxru06zk56cm8wd0hf683y77xncq9kmlzmaaxjyqgew60j` | |
| 1 | Receiver | `neutron1y9ek73d9glj8269ykkn7f9c2j3wgmxvrhr2psa8reg97a36yv92q27lvxn` | Placeholder class identity, no `indicator_id` equality check |
| 2 | Receiver | `neutron16qvwvzlh5j7fxx32hyxyn0rmrec9ls78ztxn4h62hu93pv4nn9ls3sclk0` | Code 5347; mirrored class; authorized sender derived from the wrong channel (channel-18) |
| 3 | Receiver | `neutron1md44xxvm275pn368k2kcshnfdunh78hgsd4prt6wpkvdnpstrgdqezeum5` | channel-2; before the feerefunder fix |
| 4 | Receiver | `neutron1tfy2r0pxmyp8lkng2wy0c0a9gaqwkuqljhs2h8txhy27j23q8zrsf9347m` | Code 5348; feerefunder fix |
| 5 | Receiver | `neutron1e5tfeas9y2y68cwwrt0jmjvp238wnd4z7zwp02j4s9kws9sn3hksxu08er` | Relayer `fee` field added to the GMP memo |
| 5 | BridgeHTLC | `0x5A56AeC40c353a251Aa87Fde6083dB5154e4BdA1` | Deploy `0x51e2f8adea3fa2cde550d69e05de955ebc2af3678bbcb8fcc6ff6a7a1fad29f6` |
| 6 | — | — | First fully automatic on-chain callback (S1) and both reverse-direction runs (S2); no minimum bounty yet |

## Failures induced or encountered (July 5, 2026)

| # | Event | Evidence | Failure mode |
|---|---|---|---|
| F1 | Deploy tx stuck below base fee (maxFee 200 gwei < base ~282 gwei), blocking the account nonce | tx `0xa31b815394bec8152b758224779d6c9579a6db84c153fa161aaafca2761e3dde` | Operational, not protocol |
| F2 | BridgeHTLC deploy out of gas after contract growth (gasUsed = gasLimit 3.5M, status 0) | tx `0x50ede3175032138d7ed33fb389b943b16948b7189fc2e7e871ee763e79586cd7` | Operational |
| F3 | `lockForBurn` reverted "Timelock too short": T_e submitted as now + 3600 exactly; block timestamp at inclusion was later | tx `0xb733be494a2b638d22aff8f8bc314caa41ded58aacb584f1cd4c33b0ff645f62` (34,265 gas, early require) | Guard working as designed |
| F4 | Prepare message stuck "Waiting for IBC" for 21+ min: destination had the wrong authorized sender (derived from channel-18; real inbound channel is channel-2) | lock `0x7ee89af7…b3712f7a61`; Axelar IBC tx `1C20EA9C74…FCE3170959`; second instance `0xd639318f…19f00f5b2d` | (a) prepare undelivered → refund path |
| F5 | `claim_mint` rejected by Neutron's feerefunder: plain `MsgTransfer` lacks the mandatory ack/timeout fees | Claim attempt on generation 3; no state change on Neutron (no mint) | Invalid message rejected without state change |
| F6 | Automatic callback emitted on-chain but never executed on Polygon: the memo lacked the Axelar relayer `fee` field. Packet relayed and routed on Axelar, never executed on the EVM side | lock `0x881ee0dfa616fbfdc6db1def5048e233921268a93d23766a12cac58bb0c6e504`; claim `1A140F42BB9AFEC0406F1F471993656FC581360AC0B57D6147373EABB81F00AF` (IBC packet seq 125095, channel-2 → channel-78) | (b)/(c) callback failure |
| F7 | Fallback recovery: `claimBurn` finalised the burn 1,258 s after the lock when the callback did not arrive; the bounty (0.1 POL) was paid to the caller | burn `0x6484892260710384f0b38d3c58743f37b0130504374592e8698f533c2431fc69` (113,406 gas incl. bounty payout, `BountyPaid` event) | (b) recovery through the bounty path |
| F8 | Relay-fee denomination rejection: callback with a correct memo and fee field still not executed, because NTRN is not an Axelar-registered asset; axelarnet error-acked the ICS-20 packet and refunded. Fix: dual-coin funds (untrn for the feerefunder, AXL `ibc/C0E66D1C81D8AAF0E6896E05190FDFBC222367148F86AC3EA679C28327A763CD` as relay token) | claim `06D844D26C22351755B78ECCE3F8BB61C6CE331C4CAD32C008B8D58F83F48E99` | Integration constraint; (b)/(c) in effect |
| F9 | Minimum-bounty rejection: lock with a 0.01 POL bounty (below the 0.05 floor) reverted "Bounty below protocol minimum" (generation 7) | tx `0x4afcd82fadb289d7aa9e33a3faadf82ca94d2decfd0c877d2e5cd628705a1b13` (45,442 gas, no state change) | Guard working as designed |

Failure modes refer to the five modes analysed in the thesis: (a) forward
relay failure, (b) callback failure with an observer, (c) callback failure
without an observer, (d) invalid secret, (e) unregistered or mismatched class.

## Validation sessions

**S0 — End-to-end happy path on generation 4.** Lock → claim
`725F1B1757FB0D66B0469F5EA55AAC8E36AF22F6EA0D9AC93CE95BF4EF104C8E` → manual
burn `0x71745714c1c1ef8a36cd7f03a204183faf35a228fca9f8298747a150d7bfaa1c`
(131,358 gas); forward relay 33–34 s.

**S1 — First fully automatic on-chain callback (generation 6).** Lock
`0xbcfde3d2dfa5aa070a9560f2ea2a592c137006955ed2e02c215c949f361df399`
(615,645 gas) → prepare on Neutron after 34 s → claim
`12AB3A8852ABF8D458E20A6108E73FD82B86DAA3A3E6FB68FD72EC48558A6F84`
(466,710 gas; 2 AXL relay fee + 0.45 NTRN feerefunder) → automatic callback
executed the Polygon burn after 62 s → 108 s end to end. Debug runs are
archived in `scripts/evaluation-results-debug-session.json`.

**S2 — Reverse direction, fully automatic (generation 6).** Neutron
`lock_for_burn` `1CEABA92A55DDEFCEF8DD6E5B3DFCDBD8F8899B61F2BEF2B600661A72A53E976`
(457,585 gas; escrow + 0.1 NTRN bounty) → prepare on Polygon after 55 s →
`claimMint` `0x4c3030c5a7400895efe228db5be477954c27dd57fc53783ecb87525a9c9dd2de`
(225,752 gas) → automatic `claim_burn` callback executed on Neutron after 31 s
→ 93 s end to end. The relay asymmetry inverts with respect to the forward
direction: the slow leg is always the one that originates on Cosmos.

Two escrows stranded by F4 were recovered with `scripts/refund-locks.js`:
refunds `0x1f6f511b…` and `0x1e7cbdac…` (tokens and 0.2 POL in bounties
returned).

**S3 — Final deployment (generation 7) and campaign baseline.** Campaign
run 1: lock `0x88a647f0…` (675,071 gas; the first lock on a fresh contract
initialises storage), prepare 34 s, claim `136AE925…` (466,792 gas),
automatic callback 47 s, 102 s end to end. Runs on the generation without the
minimum bounty are archived in `scripts/evaluation-results-pre-minbounty.json`.

## Integration constants

- Neutron feerefunder fees: 0.2 NTRN ack + 0.2 NTRN timeout; the timeout fee
  is refunded on successful acknowledgement.
- Neutron ↔ Axelar: channel-2 ↔ channel-78.
- IBC-hook intermediary for channel-2:
  `Bech32(sha256(sha256("ibc-wasm-hook-intermediary") || "channel-2/" || <Axelar GMP account>))`.
