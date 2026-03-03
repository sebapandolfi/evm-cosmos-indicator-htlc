# Atomic Cross-Chain Transfer of Environmental Indicator Tokens

HTLC-based atomic cross-chain bridge for environmental indicator tokens between **Polygon** (EVM) and **Neutron** (Cosmos) via **Axelar GMP**.

## Overview

This proof-of-concept implements an atomic cross-chain bridge for environmental indicators (CO2 removals, energy consumption, etc.) with:

- **Semantic Binding**: ERC-1155/CW1155 multi-token with immutable token-to-indicator mapping, preventing semantic mixing of different indicator types
- **Cryptographic Metadata Commitment**: Deterministic `indicatorId = keccak256(profileHash)` with on-chain `profileHash` and `dataHash` anchors
- **Governance Controls**: Owner-gated token class creation, bridge-only minting, authorized sender whitelist
- **HTLC with Automatic Callback**: When tokens are minted on Cosmos (revealing the secret), the contract emits callback data that triggers burning of escrowed tokens on EVM

## Architecture

```
EVM (Polygon)                    Axelar GMP                   Cosmos (Neutron)
+-----------------+                                     +----------------------+
|IndicatorToken1155|           GMP1 (lock)               | token_bridge_receiver|
|  (ERC-1155)     |    ------------------------------>   |    (CosmWasm)        |
|                 |                                      |                      |
| BridgeHTLC      |           GMP2 (callback burn)       |  Authorized senders  |
|  (HTLC+Escrow)  |    <------------------------------  |  Token class registry|
|  _execute()     |                                      |  Auto callback emit  |
+-----------------+                                     +----------------------+
```

## Deployed Contracts (Production Mainnet)

| Chain | Contract | Address |
|-------|----------|---------|
| Polygon | IndicatorToken1155 | `0x7Dbf7583c758e34D2CB4F3fd1E8C998E5469345a` |
| Polygon | BridgeHTLC | `0x078154e912A94f57be962A7B3926dbcaF0eD27e0` |
| Neutron | HTLC Bridge Receiver | `neutron1d9k5ceh44555gxru06zk56cm8wd0hf683y77xncq9kmlzmaaxjyqgew60j` |

## Prerequisites

- Node.js 18+
- Docker (for CosmWasm compilation)
- MATIC tokens on Polygon Mainnet (for EVM gas)
- NTRN tokens on Neutron Mainnet (for Cosmos gas)

## Setup

```bash
git clone https://github.com/sebapandolfi/evm-cosmos-indicator-htlc.git
cd evm-cosmos-indicator-htlc
npm install
cp .env.example .env
# Edit .env with your private keys
```

## Compilation

### EVM Contracts (Solidity)

```bash
npm run compile:evm
```

### CosmWasm Contract (Rust)

Requires Docker:

```bash
npm run compile:cosmwasm
```

## Deployment

### Deploy EVM Contracts to Polygon

```bash
npm run deploy:evm
```

### Deploy CosmWasm Contract to Neutron

```bash
npm run deploy:cosmos
```

## Testing the HTLC Flow

### Step 1: Lock tokens on Polygon

```bash
npm run test:lock
```

### Step 2: Wait for GMP relay (~2-5 minutes)

```bash
npm run test:status
```

### Step 3: Claim on Neutron (reveals secret, mints tokens)

```bash
npm run test:claim-cosmos
```

### Step 4: Finalize burn on Polygon

```bash
npm run test:claim-evm
```

## Verification

- **Axelarscan** (GMP messages): https://axelarscan.io/gmp/
- **Polygonscan** (EVM transactions): https://polygonscan.com/
- **Mintscan** (Neutron transactions): https://www.mintscan.io/neutron

### Verified Transaction History

| Step | TX Hash |
|------|---------|
| Lock (Polygon) | [`0xfb49a7ed...`](https://polygonscan.com/tx/0xfb49a7ed3790332ac3f53fde8e3eed265f130ac91539e97c9e60456a9a3c9512) |
| Claim (Neutron) | [`70D848ED...`](https://www.mintscan.io/neutron/tx/70D848ED26A6360AC7EC95ED741FA195DC237AC5A5C6C046A9FFC00962CAD8C5) |
| Burn (Polygon) | [`0x23a101b7...`](https://polygonscan.com/tx/0x23a101b785203c4bd0fd0879f1a17512bdf9bde19065f3a277dd3606e9aeaaa1) |
| GMP Relay | [Axelarscan](https://axelarscan.io/gmp/0xfb49a7ed3790332ac3f53fde8e3eed265f130ac91539e97c9e60456a9a3c9512) |

## Project Structure

```
evm-cosmos-indicator-htlc/
├── evm-contracts/
│   ├── IndicatorToken1155.sol     # ERC-1155 with semantic binding
│   └── BridgeHTLC.sol             # HTLC bridge with auto callback
├── cosmwasm-contract/
│   ├── Cargo.toml
│   └── src/
│       ├── contract.rs            # HTLC logic + callback emission
│       ├── state.rs               # State with token classes
│       ├── msg.rs                 # Execute/Query messages
│       ├── error.rs               # Error types
│       └── lib.rs                 # Module exports
├── scripts/
│   ├── deploy-htlc-evm.js        # Deploy EVM contracts
│   ├── deploy-htlc-cosmos.js     # Deploy CosmWasm contract
│   ├── htlc-quick-test.js        # Test: lock / claim-cosmos / claim-evm / status
│   └── gas-config.js             # Polygon gas configuration
├── paper/
│   └── paper_token_bridge.tex    # Academic paper (LaTeX)
├── CONTRACTS_DOCUMENTATION.md
├── hardhat.config.js
├── package.json
└── .env.example
```

## Security

10 vulnerabilities were identified and mitigated:

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

## Academic Paper

The accompanying academic paper is available in `paper/paper_token_bridge.tex`.

## Acknowledgments

This work was supported by ANII (Agencia Nacional de Investigacion e Innovacion, Uruguay) under grant code POS_NAC_2023_4_178540 and by Pyxis.

## License

MIT
