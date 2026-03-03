# Token Bridge PoC - Smart Contracts & Code Documentation

Atomic cross-chain token bridge using HTLC with automatic GMP callback, connecting Polygon (EVM) and Neutron (Cosmos) via Axelar.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    EVM Layer (Polygon Mainnet)                   │
│  ┌─────────────────────┐    ┌─────────────────────┐             │
│  │ IndicatorToken1155  │◄──►│     BridgeHTLC      │             │
│  │   (ERC-1155)        │    │ (Lock/Burn/Refund)  │             │
│  │   bridge-only mint  │    │ + _execute callback  │             │
│  └─────────────────────┘    └──────────┬──────────┘             │
└─────────────────────────────────────────┼───────────────────────┘
                                          │ GMP₁ (lock) ↓  ↑ GMP₂ (callback burn)
┌─────────────────────────────────────────┼───────────────────────┐
│                   Axelar Network (Bidirectional GMP)             │
└─────────────────────────────────────────┼───────────────────────┘
                                          │ IBC (channel-18)
┌─────────────────────────────────────────┼───────────────────────┐
│                  Cosmos Layer (Neutron Mainnet)                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              token_bridge_receiver (CosmWasm)            │    │
│  │  authorized sender whitelist + auto callback emission   │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## Deployed Contracts (Production)

### Polygon Mainnet (Chain ID: 137)

| Contract | Address |
|----------|---------|
| IndicatorToken1155 | `0x7Dbf7583c758e34D2CB4F3fd1E8C998E5469345a` |
| BridgeHTLC | `0x078154e912A94f57be962A7B3926dbcaF0eD27e0` |

### Neutron Mainnet (neutron-1)

| Contract | Address |
|----------|---------|
| HTLC Bridge Receiver (Code ID: 5164) | `neutron1d9k5ceh44555gxru06zk56cm8wd0hf683y77xncq9kmlzmaaxjyqgew60j` |

### Axelar Infrastructure

| Component | Value |
|-----------|-------|
| Gateway (Polygon) | `0x6f015F16De9fC8791b234eF68D486d2bF203FBA8` |
| Gas Service (Polygon) | `0x2d5d7d31F671F86C782533cc367F14109a082712` |
| IBC Channel (Neutron) | `channel-18` |
| Axelar IBC Relay (Neutron) | `neutron1hnsm3z9azj6vyfsgkztdeys8rl0qqg96wmftv63yhuszalxfq6msqqjttm` |

---

## EVM Contracts (Solidity)

### IndicatorToken1155.sol

**Purpose:** ERC-1155 multi-token with semantic binding. Each `tokenId` is bound to a unique `indicatorId`.

**Security features:**
- `mint()` is bridge-only (not owner)
- `mintInitialSupply()` is owner-only (for initial distribution)
- No generic `burn(from)` -- only `burnFromBridge()` (burns from bridge's own balance)
- Semantic binding is immutable once created

**Key functions:**

| Function | Access | Description |
|----------|--------|-------------|
| `createTokenClass(...)` | Owner | Create token class with semantic binding |
| `mint(to, tokenId, amount)` | Bridge only | Mint tokens |
| `mintInitialSupply(to, tokenId, amount)` | Owner only | Initial distribution |
| `burnFromBridge(tokenId, amount)` | Bridge only | Burn from bridge escrow |
| `setBridge(address)` | Owner | Set authorized bridge |

### BridgeHTLC.sol

**Purpose:** HTLC bridge with automatic callback for atomic cross-chain transfers.

**Security features:**
- `ReentrancyGuard` on all mutating functions
- Checks-Effects-Interactions pattern (state updated before external calls)
- Bech32 recipient validation (`_isValidBech32Recipient`)
- Minimum 1-hour timelock (`MIN_TIMELOCK_DURATION`)
- `_execute` callback handler for automatic burn (non-reverting)
- `onERC1155Received` and `onERC1155BatchReceived` implemented

**HTLC State Machine:**
```
EMPTY ──lockForBurn──► LOCKED ──claimBurn(S) or callback──► CLAIMED
                          │
                          └──refundBurn(timeout)──► REFUNDED
```

**Key functions:**

| Function | Description |
|----------|-------------|
| `lockForBurn(tokenId, amount, hashlock, timelock, recipient, chain, addr)` | Lock tokens, send GMP₁ to Cosmos |
| `claimBurn(hashlock, secret)` | Manual burn (fallback) |
| `refundBurn(hashlock)` | Refund after timeout (sender only) |
| `_execute(commandId, sourceChain, sourceAddress, payload)` | **Auto callback handler** -- receives GMP₂ from Cosmos, verifies secret, burns tokens |

**Callback handler (`_execute`):**
- Decodes ABI-encoded `(bytes32 hashlock, bytes32 secret)` from payload
- If lock is already CLAIMED or REFUNDED: emits `CallbackIgnored` (no revert)
- If valid: burns tokens, emits `CallbackBurnProcessed`

---

## CosmWasm Contract (Rust)

### token_bridge_receiver

**Source:** `wasm-contract/src/`

**Security features:**
- Authorized sender whitelist for `prepare_mint` (only Axelar relay can create HTLCs)
- Strict 32-byte hex validation for secrets and hashlocks
- Token class existence check before minting
- Owner-only access for admin operations and `receive_test`
- Automatic callback emission on `claim_mint`

**Key execute messages:**

| Message | Description |
|---------|-------------|
| `prepare_mint` | Register HTLC (authorized senders only) |
| `claim_mint { hashlock, secret }` | Reveal secret, mint tokens, **emit callback data** |
| `refund_mint { hashlock }` | Cancel after timeout |
| `add_authorized_sender { sender }` | Whitelist GMP sender (owner only) |
| `remove_authorized_sender { sender }` | Remove from whitelist (owner only) |
| `create_token_class { ... }` | Create token class (owner only) |
| `transfer { recipient, token_id, amount }` | Transfer tokens |

**Callback emission on `claim_mint`:**

When `claim_mint` succeeds, the contract emits structured attributes:
```
callback_status: READY
callback_destination_chain: Polygon
callback_destination_address: 0x078154e912...
callback_payload: 0x<hashlock_32bytes><secret_32bytes>
```

This data is consumed by a relayer (or Axelar GMP) to automatically call `claimBurn` on EVM.

---

## Scripts

| Script | Purpose |
|--------|---------|
| `deploy-htlc-evm.js` | Deploy IndicatorToken1155 + BridgeHTLC to Polygon |
| `htlc-quick-test.js` | All-in-one test: `lock`, `claim-cosmos`, `claim-evm`, `status` |
| `gas-config.js` | Centralized gas settings (500 gwei max, 100 gwei priority) |

**Cosmos deployment:** `neutron-deploy/deploy-htlc-cosmos.js`

---

## Verified Transaction History

| Step | Chain | TX Hash | Gas |
|------|-------|---------|-----|
| Lock | Polygon | `0xfb49a7ed3790332ac3f53fde8e3eed265f130ac91539e97c9e60456a9a3c9512` | 533,627 |
| Claim | Neutron | `70D848ED26A6360AC7EC95ED741FA195DC237AC5A5C6C046A9FFC00962CAD8C5` | 234,523 |
| Burn | Polygon | `0x23a101b785203c4bd0fd0879f1a17512bdf9bde19065f3a277dd3606e9aeaaa1` | 95,914 |

**Axelarscan:** https://axelarscan.io/gmp/0xfb49a7ed3790332ac3f53fde8e3eed265f130ac91539e97c9e60456a9a3c9512

---

## Security

10 vulnerabilities identified and fixed:

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | Critical | No access control on `prepare_mint` | Authorized sender whitelist |
| 2 | Critical | `verify_hashlock` accepts malformed input | Strict 32-byte hex validation |
| 3 | High | JSON injection via recipient | Bech32 character validation |
| 4 | High | Timeout too short for GMP | 1-hour minimum enforced |
| 5 | High | Mint without token class check | Class existence validation |
| 6 | Medium | CEI violation in `lockForBurn` | State-before-transfer + ReentrancyGuard |
| 7 | Medium | Owner can mint bypassing bridge | Bridge-only `mint()` |
| 8 | Medium | `burn(from)` on any address | Removed; only `burnFromBridge` |
| 9 | Medium | Missing `onERC1155BatchReceived` | Added |
| 10 | Low | `ReceiveTest` no access control | Owner-only |

**Double-spend prevention:** Automatic GMP callback ensures burn happens within minutes of claim, before the EVM refund window opens.
