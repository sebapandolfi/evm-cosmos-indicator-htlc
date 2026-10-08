# Changelog

## v1.1 (unreleased)

Security fixes found in a review of v1.0-tesis. They require redeploying both
contracts and are not part of the evaluated deployment.

- **CosmWasm receiver: authenticate the emitting contract.** `prepare_mint`
  checked only that the caller was an authorized sender (the IBC-hooks
  intermediary of the Axelar channel, shared by all GMP traffic) or the
  owner. It now (a) no longer accepts the owner as a caller and (b) requires
  `source_chain`/`source_address` to match a counterpart set with the new
  owner-only message `set_counterpart`. It fails closed while no counterpart
  is configured.
- **BridgeHTLC: Axelar payload version 1 for the forward prepare.** The
  prepare message is now ABI-encoded (`0x00000001`, method `prepare_mint`,
  eight string arguments). Axelar converts it to the same JSON message the
  receiver already parses and validates the `source_chain`/`source_address`
  arguments, which makes the receiver's counterpart check meaningful.
  *Needs an end-to-end test on testnet or mainnet before deployment.*
- **BridgeHTLC: bounty grace period.** `claimBurn` still burns at any time,
  but before the destination claim deadline T_c (= timelock - 30 min) the
  bounty returns to the sender instead of the caller, so racing the automatic
  callback is no longer rewarded.
- Tests: 6 CosmWasm unit tests (`cargo test`), 2 new EVM scenarios in
  `test/bounty.test.js` (36 assertions pass) and `test/reverse.test.js`
  unchanged (17 pass).

### Also in this branch (no contract change)

- `formal/HTLCCallback_v3.tla`: secret modelled as an event of its own,
  invariant NoLoss, assumption A9 and liveness L1 (`results_v3.md`).
- `measurements/overhead`: fork-based measurement of the semantic-layer
  overhead of v1.0 `lockForBurn`.
