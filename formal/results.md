# TLC model-checking results — HTLC-with-callback protocol (spec v2)

All output below is **verbatim TLC output**; the full logs are in `logs/*.log`
and are regenerated deterministically by `./run.sh` (single-worker BFS, so
state counts and counterexamples are bit-for-bit reproducible).

- **Tool**: TLC2 Version 2026.03.02.213938 (rev: 54e73ad), breadth-first
  exhaustive search, 1 worker.
- **JVM**: OpenJDK 11.0.31 (Ubuntu 22.04, aarch64).
- **Provenance of `tla2tools.jar`**: the GitHub release-asset CDN
  (`release-assets.githubusercontent.com`) is unreachable from the sandbox
  (HTTP 403 from proxy after CONNECT), so the jar was extracted from the npm
  package `tlaplus-mcp` (`package/lib/tla2tools.jar`), sha256
  `94bf268ba716c0e7fa774020247abb07da9220849db38c2c6837436d75c4fa16`. It is a
  recent official CI build (2026-03-02), newer than the latest tagged release.
- **Spec**: `HTLCCallback.tla`. `TypeOK`, `I2`, `I3a`, `I3b`, `I3c` and
  `NoStuckEscrow` are checked as state invariants; `I1` (single settlement) is
  checked as an action property `[][...]_vars`. Deadlock checking is disabled
  (`CHECK_DEADLOCK FALSE`) because the bounded clock necessarily ends in
  stuttering at `t = MaxT`.
- **Runner**: `./run.sh` (nine configurations, logs to `logs/`).
- **Version 1 of this spec is archived in `v1/`**, together with a note
  explaining the two defects that motivated v2. Its figures should not be
  cited.

## What the model contains

The model is a **single instance** of the protocol (one transfer, one hashlock)
and comprises:

- a source lock contract, `sigmaS` in `{NONE, LOCKED, CLAIMED, REFUNDED}`;
- a destination mint contract, `sigmaD` in
  `{NONE, PENDING, MINTED, REFUNDED_D}`;
- the **semantic payload**: the class and amount escrowed at the source
  (`srcTok`, `srcAmt`), the class identity and amount carried by the prepare
  message (`msgId`, `msgAmt`), and the class, amount and identity accepted at
  the destination (`dstTok`, `dstAmt`, `dstId`);
- a discrete clock `t` in `0..MaxT` with deadlines `Tc < Te`;
- a faulty relay that may **delay** (delivery simply never scheduled),
  **drop** (explicit actions, delivery disabled forever), **duplicate**
  (delivered messages stay deliverable; re-delivery is guarded to be a state
  no-op) and — when `FORGE = TRUE` — **tamper** with the prepare message.

Two registries are modelled asymmetrically, because they are asymmetric in the
implementation. `SrcId` is computed **on-chain** at the source, so it is a
fixed function of the class. `DstClass` is the destination registry, which the
contract **stores as supplied by the owner** without recomputing the
derivation; that is why its consistency with `SrcId` is an assumption (A8) and
not a cryptographic fact.

## What the model does NOT contain

Stated explicitly so that the scope of the mechanized result is not
overread. The model abstracts away: the hash preimage and its revelation (the
secret becoming public is modelled as `sigmaD = MINTED`, not as a cryptographic
event); authorization and ownership checks; the bounty and the economics that
make the monitor's action rational; gas, fees and the pull-payment mechanism;
multiple concurrent transfers; and the internals of the underlying messaging
protocols (Axelar GMP, IBC), which are treated as an unreliable channel.

## Regime constants

| Constant | Meaning | Assumption |
|---|---|---|
| `MONITOR` | a bounty-incented monitor acts before `Te` | A4 |
| `FORGE` | the relay may tamper with the prepare message | negation of A6 |
| `REGISTRY_OK` | the owner mirrors class identities consistently | A8 |

`FORGE = TRUE` models the **negation** of A6 (honest relay);
`REGISTRY_OK = FALSE` models the **negation** of A8.

## Summary table

Constants are `Tc=4, Te=6, MaxT=8` unless noted.

| Configuration | Regime | Result | Generated | Distinct | Depth |
|---|---|---|---|---|---|
| `MC_Base` | all assumptions | **No error**: TypeOK, I1, I2, I3a, I3b, I3c, NoStuckEscrow | 1 461 | 505 (exhaustive) | 15 |
| `MC_Base_Tc3Te5` | all assumptions, `Tc=3, Te=5` | **No error** (same seven) | 1 493 | 521 (exhaustive) | 15 |
| `MC_NoMonitor` | ¬A4 | **I2 VIOLATED** (11-state trace) | 877 | 360 (search halted) | 11 |
| `MC_NoMonitor_Rest` | ¬A4, I2 removed | **No error**: I1, I3a, I3b, I3c | 1 685 | 601 (exhaustive) | 15 |
| `MC_Forge_I3a` | ¬A6 | **I3a VIOLATED** (5-state trace) | 356 | 161 (search halted) | 5 |
| `MC_Forge_I3b` | ¬A6 | **I3b VIOLATED** (5-state trace) | 383 | 173 (search halted) | 5 |
| `MC_Forge_Rest` | ¬A6, I3a/I3b removed | **No error**: I1, I2, I3c, NoStuckEscrow | 55 869 | 10 185 (exhaustive) | 17 |
| `MC_NoA8_I3a` | ¬A8, **honest relay** | **I3a VIOLATED** (4-state trace) | 34 | 26 (search halted) | 4 |
| `MC_NoA8_Rest` | ¬A8, I3a removed | **No error**: I1, I2, I3b, I3c, NoStuckEscrow | 1 461 | 505 (exhaustive) | 15 |

The `*_Rest` configurations exist because a run that halts on a violation
cannot certify the remaining invariants over the *full* state space. Removing
the refuted invariant lets TLC enumerate the regime exhaustively and establish
precisely what survives the failure of that assumption. For the exhaustive runs
TLC reports optimistic fingerprint-collision probabilities between 2.5E-11 and
2.1E-15, effectively exact at these state-space sizes.

## Reading of the results

**Each of A4, A6 and A8 is load-bearing, and each carries a different
property.** The four violations are not redundant: dropping A4 refutes supply
conservation only; dropping A6 refutes both clauses of semantic preservation
but leaves supply conservation intact; dropping A8 refutes the class clause
alone, and does so **with a fully honest relay**.

**The shortest counterexample in the whole set is the A8 one: four states.** No
adversary, no message loss, no timing. The owner registers a destination class
under the identity of a different class; a lock of `cB` is delivered honestly
and the destination mints `cA`. This is the cleanest available demonstration
that content-addressed identity does not, on its own, buy semantic preservation
across chains: the derivation is computed on-chain only at the source, so the
guarantee reduces to the correctness of the mirrored registration.

**Semantic preservation does not depend on A4.** `MC_NoMonitor_Rest` enumerates
all 601 states of the no-monitor regime and finds I3a, I3b and I3c intact. This
is the asymmetry between the properties: atomicity and supply conservation rest
on a liveness assumption about a third party, whereas class and amount
preservation rest on registration and relay integrity instead.

**What survives a Byzantine relay is worth stating precisely.**
`MC_Forge_Rest` establishes, over 10 185 states, that even a relay free to
rewrite the identity and amount of every message cannot produce a refund
together with a mint (I2), cannot reanimate a settled side (I1), and cannot get
a mint accepted under an identity absent from the destination registry (I3c).
What it *can* do is redirect a transfer into a different registered class and
change the amount. The destination guard is a real containment boundary, but it
contains less than the class-identity mechanism might suggest at first reading.

**The stuck escrow of v1 is gone.** `NoStuckEscrow` is verified in every regime
where A4 is in force and holds in all of them, including under a Byzantine
relay. Expressing A4 as a constraint on the clock rather than as a guard on the
refund removes the artefact without weakening the refund guard, which now
mentions only source-chain state and the clock, exactly as the deployed
contract does.

**What TLC contributes here.** Once the assumptions are in place, each positive
result has a short hand proof; the model checker's contribution is not depth
but exhaustiveness and minimality. It mechanizes the arguments over every
interleaving of the contracts, the clock and a faulty relay; it exhibits the
*minimal* counterexample in each failing regime (notably: the I2 violation
needs mere delay, not an explicit drop, and the A8 violation needs no fault at
all); and it rules out by enumeration that some other ordering produces a
violation that the hand argument missed. The negative results are the more
informative half: they locate exactly which assumption carries which property.

## Counterexample 1 — I3a under ¬A8 (`MC_NoA8_I3a`), honest relay

Scenario: the owner has registered the destination class `cA` under the
identity `iB`, which the source derives for class `cB`. The user escrows one
unit of `cB` at `t=0`; the relay delivers the prepare message faithfully; the
destination resolves `iB` through its own registry and opens a pending mint of
class **`cA`**; the user claims. Final state: `srcTok = "cB"` but
`dstTok = "cA"` — the transfer crossed a class boundary with no adversary
involved.

```
Error: Invariant I3a is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\ msgId = "noid"
/\ srcTok = "none"
/\ prepInFlight = FALSE
/\ dstTok = "none"
/\ srcAmt = 0
/\ msgAmt = 0
/\ dstAmt = 0
/\ cbDropped = FALSE
/\ t = 0
/\ sigmaD = "NONE"
/\ prepDropped = FALSE
/\ cbInFlight = FALSE
/\ sigmaS = "NONE"
/\ dstId = "noid"

State 2: <LockForBurn line 137, col 5 to line 144, col 55 of module HTLCCallback>
/\ msgId = "iB"
/\ srcTok = "cB"
/\ prepInFlight = TRUE
/\ dstTok = "none"
/\ srcAmt = 1
/\ msgAmt = 1
/\ dstAmt = 0
/\ cbDropped = FALSE
/\ t = 0
/\ sigmaD = "NONE"
/\ prepDropped = FALSE
/\ cbInFlight = FALSE
/\ sigmaS = "LOCKED"
/\ dstId = "noid"

State 3: <RelayDeliverPrepare line 153, col 5 to line 162, col 69 of module HTLCCallback>
/\ msgId = "iB"
/\ srcTok = "cB"
/\ prepInFlight = TRUE
/\ dstTok = "cA"
/\ srcAmt = 1
/\ msgAmt = 1
/\ dstAmt = 1
/\ cbDropped = FALSE
/\ t = 0
/\ sigmaD = "PENDING"
/\ prepDropped = FALSE
/\ cbInFlight = FALSE
/\ sigmaS = "LOCKED"
/\ dstId = "iB"

State 4: <ClaimMint line 186, col 5 to line 191, col 80 of module HTLCCallback>
/\ msgId = "iB"
/\ srcTok = "cB"
/\ prepInFlight = TRUE
/\ dstTok = "cA"
/\ srcAmt = 1
/\ msgAmt = 1
/\ dstAmt = 1
/\ cbDropped = FALSE
/\ t = 0
/\ sigmaD = "MINTED"
/\ prepDropped = FALSE
/\ cbInFlight = TRUE
/\ sigmaS = "LOCKED"
/\ dstId = "iB"

34 states generated, 26 distinct states found, 15 states left on queue.
The depth of the complete state graph search is 4.
```

## Counterexample 2 — I3a under ¬A6 (`MC_Forge_I3a`), Byzantine relay

Scenario: the user escrows one unit of `cA`, whose identity `iA` travels in the
prepare message. The relay rewrites the identity to `iB`. Because `iB` **is**
registered at the destination, the guard admits the message and the destination
mints class `cB`. Final state: a mint of `cB` backed by an escrow of `cA`. Note
what this shows: the destination guard blocks unregistered identities but
cannot detect a substitution between two legitimately registered ones.

```
Error: Invariant I3a is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\ msgId = "noid"
/\ srcTok = "none"
/\ prepInFlight = FALSE
/\ dstTok = "none"
/\ srcAmt = 0
/\ msgAmt = 0
/\ dstAmt = 0
/\ cbDropped = FALSE
/\ t = 0
/\ sigmaD = "NONE"
/\ prepDropped = FALSE
/\ cbInFlight = FALSE
/\ sigmaS = "NONE"
/\ dstId = "noid"

State 2: <LockForBurn line 137, col 5 to line 144, col 55 of module HTLCCallback>
/\ msgId = "iA"
/\ srcTok = "cA"
/\ prepInFlight = TRUE
/\ dstTok = "none"
/\ srcAmt = 1
/\ msgAmt = 1
/\ dstAmt = 0
/\ cbDropped = FALSE
/\ t = 0
/\ sigmaD = "NONE"
/\ prepDropped = FALSE
/\ cbInFlight = FALSE
/\ sigmaS = "LOCKED"
/\ dstId = "noid"

State 3: <RelayForgePrepare line 174, col 5 to line 181, col 69 of module HTLCCallback>
/\ msgId = "iB"
/\ srcTok = "cA"
/\ prepInFlight = TRUE
/\ dstTok = "none"
/\ srcAmt = 1
/\ msgAmt = 1
/\ dstAmt = 0
/\ cbDropped = FALSE
/\ t = 0
/\ sigmaD = "NONE"
/\ prepDropped = FALSE
/\ cbInFlight = FALSE
/\ sigmaS = "LOCKED"
/\ dstId = "noid"

State 4: <RelayDeliverPrepare line 153, col 5 to line 162, col 69 of module HTLCCallback>
/\ msgId = "iB"
/\ srcTok = "cA"
/\ prepInFlight = TRUE
/\ dstTok = "cB"
/\ srcAmt = 1
/\ msgAmt = 1
/\ dstAmt = 1
/\ cbDropped = FALSE
/\ t = 0
/\ sigmaD = "PENDING"
/\ prepDropped = FALSE
/\ cbInFlight = FALSE
/\ sigmaS = "LOCKED"
/\ dstId = "iB"

State 5: <ClaimMint line 186, col 5 to line 191, col 80 of module HTLCCallback>
/\ msgId = "iB"
/\ srcTok = "cA"
/\ prepInFlight = TRUE
/\ dstTok = "cB"
/\ srcAmt = 1
/\ msgAmt = 1
/\ dstAmt = 1
/\ cbDropped = FALSE
/\ t = 0
/\ sigmaD = "MINTED"
/\ prepDropped = FALSE
/\ cbInFlight = TRUE
/\ sigmaS = "LOCKED"
/\ dstId = "iB"

356 states generated, 161 distinct states found, 111 states left on queue.
The depth of the complete state graph search is 5.
```

## Counterexample 3 — I2 under ¬A4 (`MC_NoMonitor`)

Unchanged in shape from v1, and reproduced in full in
`logs/MC_NoMonitor.log`. The user locks at `t=0`, the prepare message is
delivered, the user claims the mint at `t=0 (< Tc=4)`, publishing the secret
and emitting the callback; the relay **merely delays** the callback (never
delivered, never explicitly dropped); the clock reaches `t=6 (= Te)` and the
user refunds the source escrow. Final state:
`sigmaS = "REFUNDED"` and `sigmaD = "MINTED"` — unbacked supply. Eleven states,
after exploring 360 distinct states.

The `MC_Forge_I3b` counterexample is the amount-clause analogue of
counterexample 2 (the relay rewrites `msgAmt` from 1 to 2, and the destination
mints two units against an escrow of one); see `logs/MC_Forge_I3b.log`.
