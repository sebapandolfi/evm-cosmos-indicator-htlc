# Semantic overhead of lockForBurn — measured

Setup: Hardhat 2.29.1 fork of Polygon mainnet (block 95197171 / 95197230, via
publicnode), real Axelar gateway 0x6f015F16… and gas service 0x2d5d7d31…,
contracts compiled exactly as in the repo (solc 0.8.19, viaIR, 1000 runs).
Variant BridgeHTLCNoSemantic = BridgeHTLC minus: token.getIndicatorId call,
_bytes32ToHexString(indicatorId) and the "indicator_id" JSON field
(diff in variant.diff). Parameters as in the campaign (amount 1e18, bounty
0.1 POL, msg.value 1 POL, destination 'neutron', same recipient/contract).

| rep | BridgeHTLC | NoSemantic | delta |
|---|---|---|---|
| 1 (cold) | 610,391 | 586,046 | 24,345 |
| 2 | 559,091 | 534,746 | 24,345 |
| 3 | 559,091 | 534,734 | 24,357 |
| 4 | 559,091 | 534,746 | 24,345 |
| 5 | 559,091 | 534,746 | 24,345 |

Attribution of the delta (rep 2, struct-log tracer): token calls +5,007
(getIndicatorId; cold-account cost moves to safeTransferFrom in the variant),
gas service +36, gateway +555 (84 extra payload bytes in the ContractCall
log), bridge own code +18,747 (bytes32→hex loop and JSON concatenation).

Mainnet check (run 100, tx 0x974ca7fb…, callTracer via drpc): lockForBurn
639,191 gas; subcalls: getIndicatorId 5,764; safeTransferFrom 45,252; gas
service 14,437; gateway 17,875 → Axelar calls = 32,312 gas (5.1 %). Bridge own code 555,863.

Overhead ratios (24,345 gas; 0.00851 POL at 349.6 gwei; ≈ US$0.00067 at
POL = US$0.0785):
- vs lockForBurn gas (639,191): 3.8 %
- vs Axelar on-chain calls (32,312): 75 %
- vs net monetary cost of messaging (0.1421 POL + 1 AXL ≈ US$0.0516): 1.3 %
- vs net cost of the POL+AXL legs of the transfer (≈ US$0.069): ≈ 1.0 %
Destination guard (CosmWasm prepare_mint: one TOKEN_CLASSES read and a string
comparison) not measured; it runs on Neutron within the forward delivery,
which the relay settles against the POL prepay.

## Sensitivity to the gas price

The numerator (24,345 gas) is paid in source gas, so its POL value scales
with the gas price; the denominator does not (the forward relay is settled
against destination consumption and the callback fee is paid in AXL). The
campaign used a fixed 100 gwei priority fee over a median base fee of
249.6 gwei (34 lock blocks):

| Gas price | Overhead (US$) | vs net messaging | vs net transfer |
|---|---|---|---|
| Campaign effective, 349.6 gwei | 0.000668 | 1.29 % | 0.97 % |
| Base fee + 30 gwei tip, 279.6 gwei | 0.000534 | 1.03 % | 0.77 % |
| Base fee only, 249.6 gwei | 0.000477 | 0.92 % | 0.69 % |
