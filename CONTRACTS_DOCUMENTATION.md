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
                                          │ IBC (channel-2)  
┌─────────────────────────────────────────┼───────────────────────┐
│                  Cosmos Layer (Neutron Mainnet)                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              token_bridge_receiver (CosmWasm)            │    │
│  │  authorized sender whitelist + auto callback emission   │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## Deployed Contracts (evaluated deployment)

These are the contracts the evaluation campaign ran against. Earlier generations, including the initial release, are listed in `EXPERIMENT-LOG.md`.

### Polygon Mainnet (Chain ID: 137)

| Contract | Address |
|----------|---------|
| IndicatorToken1155 | `0x3E784515e367507144CB3e664E6419Ea8aCD7040` |
| BridgeHTLC | `0x810B1CD48B50a8Ae6594C2ac46f6A5bFA9Ab5F6b` |

### Neutron Mainnet (neutron-1)

| Contract | Address |
|----------|---------|
| token_bridge_receiver | `neutron15zvjz96kqzqq9vnmp409j58wf6he4jhd5dtx9ntxsrm6wvnp5h5q72nvsz` |

### Axelar Infrastructure

| Component | Value |
|-----------|-------|
| Gateway (Polygon) | `0x6f015F16De9fC8791b234eF68D486d2bF203FBA8` |
| Gas Service (Polygon) | `0x2d5d7d31F671F86C782533cc367F14109a082712` |
| IBC Channel (Neutron ↔ Axelar) | `channel-2` ↔ `channel-78` |
| Axelar GMP account | `axelar1dv4u5k73pzqrxlzujxg3qp8kvc3pje7jtdvu72npnt5zhq05ejcsn5qme5` |
| Authorized IBC-hook intermediary (Neutron) | `neutron1hnsm3z9azj6vyfsgkztdeys8rl0qqg96wmftv63yhuszalxfq6msqqjttm` |

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

**Purpose:** HTLC bridge with automatic callback for atomic cross-chain transfers. Acts as the source for Polygon → Neutron and as the destination for Neutron → Polygon.

**Security features:**
- `ReentrancyGuard` on all mutating functions
- Checks-Effects-Interactions pattern (state updated before external calls)
- Bech32 recipient validation (`_isValidBech32Recipient`)
- Minimum 1-hour timelock (`MIN_TIMELOCK_DURATION`)
- `_execute` callback handler for automatic burn (non-reverting)
- `onERC1155Received` and `onERC1155BatchReceived` implemented
- Escrowed bounty with a protocol minimum (`minBounty`, owner-adjustable); paid to whoever finalises the burn via `claimBurn`, returned to the sender on the automatic and refund paths
- Pull-payment fallback (`pendingWithdrawals`) when a bounty transfer fails
- Reverse-direction prepare messages accepted only from the configured counterpart (`setAuthorizedSource`) and only for a registered class with the same `indicatorId`

**HTLC State Machine:**
```
EMPTY ──lockForBurn──► LOCKED ──claimBurn(S) or callback──► CLAIMED
                          │
                          └──refundBurn(timeout)──► REFUNDED
```

**Key functions:**

| Function | Description |
|----------|-------------|
| `lockForBurn(tokenId, amount, hashlock, timelock, recipient, chain, addr, bounty)` | `payable`: escrow tokens and bounty, pay GMP gas, send GMP₁ to Cosmos |
| `claimBurn(hashlock, secret)` | Fallback burn by anyone holding the public secret; pays the bounty to the caller |
| `refundBurn(hashlock)` | Refund tokens and bounty after timeout (sender only) |
| `withdrawPending()` | Withdraw a bounty whose direct transfer failed |
| `_execute(commandId, sourceChain, sourceAddress, payload)` | Relay entry point: burn callback (64-byte payload) or reverse-direction prepare (tagged payload) |
| `claimMint(hashlock, secret)` | Reverse direction: reveal the secret, mint, send the burn callback to Neutron |
| `refundMint(hashlock)` | Reverse direction: cancel a pending mint after its claim deadline |
| `setMinBounty(amount)` / `setAuthorizedSource(chain, addr)` | Owner configuration |

**Callback handler (`_execute`):**
- Decodes ABI-encoded `(bytes32 hashlock, bytes32 secret)` from payload
- If lock is already CLAIMED or REFUNDED: emits `CallbackIgnored` (no revert)
- If valid: burns tokens, returns the bounty to the sender, emits `CallbackBurnProcessed`

---

## CosmWasm Contract (Rust)

### token_bridge_receiver

**Source:** `cosmwasm-contract/src/`

**Security features:**
- Authorized sender whitelist for `prepare_mint` (only Axelar relay can create HTLCs)
- Strict 32-byte hex validation for secrets and hashlocks
- `prepare_mint` requires the class to be registered **and** its `indicator_id` to equal the message's (existence alone is not enough)
- Owner-only access for admin operations and `receive_test`
- Automatic on-chain callback on `claim_mint`
- Protocol-minimum bounty on the reverse-direction `lock_for_burn`

**Key execute messages:**

| Message | Description |
|---------|-------------|
| `prepare_mint` | Register HTLC (authorized senders only) |
| `claim_mint { hashlock, secret }` | Reveal secret, mint tokens, **send the callback on-chain** |
| `refund_mint { hashlock }` | Cancel after timeout |
| `lock_for_burn { ... }` | Reverse direction: escrow tokens and bounty, send the prepare message to Polygon |
| `claim_burn { hashlock, secret }` | Reverse direction: burn the escrow (relayed callback or manual fallback) |
| `refund_burn { hashlock }` | Reverse direction: refund tokens and bounty after timeout |
| `withdraw_funds { denom, amount, to }` | Recover refunds of failed IBC transfers held by the contract (owner only) |
| `add_authorized_sender { sender }` | Whitelist GMP sender (owner only) |
| `remove_authorized_sender { sender }` | Remove from whitelist (owner only) |
| `create_token_class { ... }` | Create token class (owner only) |
| `transfer { recipient, token_id, amount }` | Transfer tokens |

**Callback on `claim_mint`:**

When `claim_mint` succeeds, the contract sends the callback on-chain as a `/neutron.transfer.MsgTransfer` to the Axelar GMP account, carrying a GMP memo whose payload is `bytes32(hashlock) || bytes32(secret)`. The call must attach two coins:

- `untrn` for Neutron's mandatory feerefunder fees (0.2 NTRN ack + 0.2 NTRN timeout; the timeout fee is refunded on success);
- an Axelar-registered asset (AXL) as the relayer fee. NTRN itself is not an Axelar asset and is rejected.

The relay then executes `_execute` on Polygon, which burns the escrow (`callback_status: SENT_ONCHAIN`). If the funds or the configuration are missing, the contract falls back to emitting the callback as attributes only (`callback_status: READY`), and the burn must be finalised with `claimBurn`.

---

## Scripts

| Script | Purpose |
|--------|---------|
| `deploy-htlc-evm.js` | Deploy IndicatorToken1155 + BridgeHTLC to Polygon |
| `deploy-htlc-cosmos.js` | Deploy token_bridge_receiver to Neutron |
| `set-authorized-source.js` / `add-authorized-sender.js` | Link the two contracts (reverse and forward direction) |
| `htlc-quick-test.js` | All-in-one test: `lock`, `claim-cosmos`, `claim-evm`, `status` |
| `htlc-reverse-test.js` | Reverse-direction end-to-end run |
| `htlc-evaluation.js`, `campaign-*.js` | Evaluation campaign and analysis (see README) |
| `refund-locks.js`, `cancel-pending.js`, `debug-tx.js` | Operational recovery and debugging |
| `gas-config.js` | Centralized gas settings (500 gwei max, 100 gwei priority) |

---

## Verified Transaction History (initial release)

These transactions belong to the initial release. Transactions of the evaluated deployment are in `scripts/evaluation-results.json` and `EXPERIMENT-LOG.md`.

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

**Double-spend prevention:** the automatic callback burns the escrow about a minute after the claim (median 47 s in the evaluation campaign), far inside the 30-minute window before the source refund opens. If the callback fails, the escrowed bounty makes it profitable for any observer to finalise the burn with the public secret before the refund.
