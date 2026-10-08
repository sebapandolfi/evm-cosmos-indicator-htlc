# Atomic Cross-Chain Transfer of Environmental Indicator Tokens

HTLC-based atomic cross-chain bridge for environmental indicator tokens between **Polygon** (EVM) and **Neutron** (Cosmos) via **Axelar GMP**.

This repository contains the prototype, the mainnet evaluation data and the TLA+ model that back the master's thesis *Interoperabilidad blockchain para indicadores ambientales* (PEDECIBA Informática, Universidad de la República). The tag `v1.0-tesis` marks the exact version cited by the thesis.

## Overview

This proof of concept implements an atomic cross-chain bridge for environmental indicators (CO2 removals, energy consumption, etc.) with:

- **Semantic binding**: ERC-1155 / CosmWasm multi-class tokens with an immutable token-to-indicator mapping. The destination mints only into a registered class whose `indicatorId` **equals** the one carried by the message, preventing semantic mixing of different indicator types.
- **Content-addressed identity**: `indicatorId = keccak256(profileHash)`, derived on-chain at class registration, with `profileHash` and `dataHash` anchored on-chain.
- **HTLC with automatic on-chain callback**: when tokens are minted on the destination (revealing the secret), the destination contract sends the callback as a real IBC transfer carrying an Axelar GMP memo, and the relay burns the escrow on the source with no further user action.
- **Bounty-backed fallback**: every lock escrows a bounty (above a protocol minimum). If the callback does not arrive, anyone can finalise the burn with the public secret (`claimBurn`) and collect the bounty. Failed bounty transfers fall back to pull payments.
- **Bidirectional**: both contracts act as source in one direction and destination in the other (Polygon → Neutron and Neutron → Polygon).
- **Governance controls**: owner-gated class registration, bridge-only minting, authorized inbound source.

## Architecture

```
EVM (Polygon)                      Axelar GMP                    Cosmos (Neutron)
+--------------------+                                     +------------------------+
| IndicatorToken1155 |        GMP1 (prepare_mint)          | token_bridge_receiver  |
|   (ERC-1155)       |   -------------------------------> |   (CosmWasm)           |
|                    |                                     |                        |
| BridgeHTLC         |        GMP2 (callback burn)         |  Mirrored class        |
|  (HTLC + escrow    |   <------------------------------- |  registry, identity    |
|   + bounty)        |   (IBC transfer + GMP memo)         |  check, auto callback  |
+--------------------+                                     +------------------------+
```

## Deployed Contracts (evaluated deployment, Polygon and Neutron mainnet)

| Chain | Contract | Address |
|-------|----------|---------|
| Polygon | IndicatorToken1155 | `0x3E784515e367507144CB3e664E6419Ea8aCD7040` |
| Polygon | BridgeHTLC | `0x810B1CD48B50a8Ae6594C2ac46f6A5bFA9Ab5F6b` |
| Neutron | token_bridge_receiver | `neutron15zvjz96kqzqq9vnmp409j58wf6he4jhd5dtx9ntxsrm6wvnp5h5q72nvsz` |

These are the contracts the 50-run evaluation campaign executed against. Earlier generations, including the initial release, are listed in [`EXPERIMENT-LOG.md`](EXPERIMENT-LOG.md).

## Prerequisites

- Node.js 18+
- Docker (for CosmWasm compilation)
- POL on Polygon mainnet (gas, relay fee and bounty)
- NTRN on Neutron mainnet (gas and feerefunder fees) and AXL on Neutron (callback relay fee)
- Java 11+ and `tla2tools.jar` (only to re-run the TLA+ model checking)

## Setup

```bash
git clone https://github.com/sebapandolfi/evm-cosmos-indicator-htlc.git
cd evm-cosmos-indicator-htlc
npm install
cp .env.example .env
# Edit .env: keys, and the contract addresses you want to target
```

Set the contract addresses in `.env`. Some scripts fall back to addresses of earlier deployments when a variable is missing.

## Compilation

```bash
npm run compile:evm        # Solidity, via Hardhat
npm run compile:cosmwasm   # Rust/CosmWasm, via the cosmwasm/optimizer Docker image
```

## Unit Tests

The EVM-side tests run on a local Hardhat network against Axelar mocks (`evm-contracts/mocks/`):

```bash
node scripts/compile-local.js                       # solc-js build into artifacts-local/
npx hardhat run --no-compile test/bounty.test.js    # bounty, fallback, refund, pull payments
npx hardhat run --no-compile test/reverse.test.js   # reverse direction (EVM as destination)
```

## Deployment

```bash
npm run deploy:evm      # IndicatorToken1155 + BridgeHTLC on Polygon
npm run deploy:cosmos   # token_bridge_receiver on Neutron
```

After deploying, register the same class on both chains, then link the contracts with `scripts/set-authorized-source.js` and `scripts/add-authorized-sender.js`.

## Running a Transfer

Forward direction (Polygon → Neutron):

```bash
npm run test:lock           # lock on Polygon (escrow + bounty)
npm run test:status         # wait for the prepare message on Neutron
npm run test:claim-cosmos   # claim on Neutron: reveals the secret, mints, sends the callback
npm run test:claim-evm      # only if the callback did not arrive: manual claimBurn fallback
```

Reverse direction (Neutron → Polygon):

```bash
node scripts/htlc-reverse-test.js run
```

## Evaluation Campaign

| Script | Purpose |
|--------|---------|
| `scripts/htlc-evaluation.js` | Runs end-to-end transfers and records gas and per-leg latency (`run-batch N`, `analyze`, `refund-test`) |
| `scripts/campaign-runner.js` | Spreads batches across several days at randomized times until the target sample size is reached |
| `scripts/campaign-analyze.js` | Latency percentiles, CDF points and summary tables |
| `scripts/campaign-cost.js` | Cost per transfer from on-chain receipts and Axelarscan (read-only) |
| `scripts/htlc-reverse-test.js` | Reverse-direction runs |
| `scripts/bounty-demo.js` | Stalled callback recovered by an independent monitor key |

### Data

| File | Contents |
|------|----------|
| `scripts/evaluation-results.json` | Campaign: 100 scheduled runs, 50 completed (runs 17–66 aborted before locking when the operator wallet ran out of relay-fee funds); transaction hashes, gas and latency per run |
| `scripts/reverse-results.json` | The two reverse-direction runs |
| `scripts/campaign-cost.json`, `.csv` | Cost decomposition for the 34 runs with price data available |
| `scripts/latency-cdf.csv`, `latency-cdf.png` | End-to-end latency CDF |
| `scripts/evaluation-results-*.json` | Archived runs from earlier contract generations |

`evaluation-results.json` carries a `summaryProvenance` note: an earlier version of the summary contained a hard-coded callback success rate, which was replaced by the value computed from the runs (`.orig-summary` keeps the previous file).

## Formal Verification (TLA+)

`formal/` contains the TLA+ specification of the protocol state machine (`HTLCCallback.tla`), nine TLC configurations and their logs. Each configuration drops one assumption at a time (rational monitor, honest relay, consistent mirrored registry) to show which invariant each assumption carries.

```bash
cd formal
# download tla2tools.jar from https://github.com/tlaplus/tlaplus/releases into this directory
./run.sh
```

`formal/results.md` reports every run with its verbatim TLC output. `formal/v1/` archives the first version of the model, which was superseded and should not be cited.

## Verification on Block Explorers

- **Axelarscan** (GMP messages): https://axelarscan.io/gmp/
- **Polygonscan** (EVM transactions): https://polygonscan.com/
- **Mintscan** (Neutron transactions): https://www.mintscan.io/neutron

First run of the evaluation campaign:

| Step | TX Hash |
|------|---------|
| Lock (Polygon) | [`0x88a647f0...`](https://polygonscan.com/tx/0x88a647f02e4da689326ff708975c0bcd99511a7ee3f67683fc81523bbe90d29f) |
| GMP relay | [Axelarscan](https://axelarscan.io/gmp/0x88a647f02e4da689326ff708975c0bcd99511a7ee3f67683fc81523bbe90d29f) |
| Claim (Neutron) | [`136AE925...`](https://www.mintscan.io/neutron/tx/136AE9259E1A20C5A38937105F9A5809C6FA591EDAFE70DAF684E64D820FB541) |

The burn on Polygon is executed by the relay when the callback arrives. All campaign hashes are in `scripts/evaluation-results.json`.

## Project Structure

```
evm-cosmos-indicator-htlc/
├── evm-contracts/
│   ├── IndicatorToken1155.sol     # ERC-1155 with semantic binding
│   ├── BridgeHTLC.sol             # HTLC bridge: escrow, bounty, callback, reverse direction
│   └── mocks/AxelarMocks.sol      # Gateway and gas-service mocks for unit tests
├── cosmwasm-contract/
│   ├── Cargo.toml, Cargo.lock
│   └── src/                       # contract.rs, state.rs, msg.rs, error.rs, lib.rs
├── scripts/                       # deployment, admin, evaluation and analysis scripts + data
├── test/                          # unit tests (bounty, reverse direction)
├── formal/                        # TLA+ spec, TLC configs, logs and results
├── EXPERIMENT-LOG.md              # deployments by generation and mainnet failure chronology
├── CONTRACTS_DOCUMENTATION.md
├── hardhat.config.js
├── package.json
└── .env.example
```

## Security

10 vulnerabilities were identified and mitigated in the initial release:

| Severity | Issue | Fix |
|----------|-------|-----|
| Critical | No access control on `prepare_mint` | Authorized sender whitelist |
| Critical | `verify_hashlock` accepts malformed input | Strict 32-byte hex validation |
| High | JSON injection via recipient | Bech32 character validation |
| High | Timeout too short for GMP relay | 1-hour minimum enforced |
| High | Mint without token class check | Class existence validation |
| Medium | CEI violation in `lockForBurn` | State-before-transfer + ReentrancyGuard |
| Medium | Owner can mint bypassing bridge | Bridge-only `mint()` |
| Medium | `burn(from)` on any address | Removed; only `burnFromBridge` |
| Medium | Missing `onERC1155BatchReceived` | Added |
| Low | `ReceiveTest` no access control | Owner-only |

Added since:

| Issue | Fix |
|-------|-----|
| Class existence is not enough: a message could mint into a registered class with different semantics | `prepare_mint` requires `indicator_id` equality, not just existence |
| A sender with zero bounty can induce a callback failure and refund after the timeout while keeping the destination mint | Protocol-minimum bounty (`minBounty` / `min_bounty`) |
| A reverting bounty recipient could block the fallback | Pull-payment fallback (`withdrawPending`) |

The contracts are not upgradeable, and the owner can change the minimum bounty and the authorized inbound source. This is acceptable for a prototype but not for a deployment with real economic value.

## Acknowledgments

This work was supported by ANII (Agencia Nacional de Investigacion e Innovacion, Uruguay) under grant code POS_NAC_2023_4_178540 and by Pyxis.

## License

MIT
