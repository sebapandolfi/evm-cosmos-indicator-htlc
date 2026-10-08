# TLC model-checking results — HTLC-with-callback protocol

All output below is **verbatim TLC output**; the full logs are in `logs/*.log`
and are regenerated deterministically by `./run.sh` (single-worker BFS, so
state counts and the counterexample below are bit-for-bit reproducible).

- **Tool**: TLC2 Version 2026.03.02.213938 (rev: 54e73ad), breadth-first exhaustive search, 1 worker.
- **JVM**: OpenJDK 11.0.31 (Ubuntu 22.04, aarch64).
- **Provenance of `tla2tools.jar`**: the GitHub release-asset CDN
  (`release-assets.githubusercontent.com`) is unreachable from the sandbox
  (HTTP 403 from proxy after CONNECT), so the jar was extracted from the npm
  package `tlaplus-mcp` (`package/lib/tla2tools.jar`), sha256
  `94bf268ba716c0e7fa774020247abb07da9220849db38c2c6837436d75c4fa16`,
  identical to the jar in this directory. It is a recent official CI build
  (2026-03-02), newer than the latest tagged release.
- **Spec**: `HTLCCallback.tla`. Invariants `TypeOK`, `I2`, `I3` checked as
  state invariants; `I1` (single settlement / terminal states absorbing)
  checked as an action property `[][...]_vars`, which also verifies that
  duplicate relay deliveries are no-ops. Deadlock checking is disabled
  (`CHECK_DEADLOCK FALSE`) because the bounded clock necessarily ends in
  stuttering at `t = MaxT`.
- **Runner**: `./run.sh` (runs all five configurations, logs to `logs/`).

## Modeling choices (read before citing)

1. **Faulty relay.** Delay is modeled implicitly (the scheduler may never pick
   a delivery action); drop is an explicit action (`RelayDropPrepare`,
   `RelayDropCallback`) that disables delivery forever; duplication is modeled
   by keeping delivered messages deliverable — re-delivery is guarded to be a
   state no-op, and `I1` verifies this over every explored transition.
2. **Assumption A4 (rational monitor), `MONITOR = TRUE`.** Modeled as an
   **oracle abstraction**, not as fairness: besides enabling
   `MonitorClaimBurn` (secret public, source `LOCKED`, `t < Te`), the guard of
   `RefundBurn` acquires the extra conjunct `sigmaD /= "MINTED"`, i.e. "if the
   secret is public, some monitor claims the lock before the user's refund
   executes." This was a deliberate choice: "the monitor eventually acts" is a
   fairness (liveness) hypothesis, and TLC's *safety* check under all
   interleavings would still exhibit the schedule in which the monitor is
   never picked before `Te`; encoding A4 in the guard keeps `I2` a pure safety
   property certifiable by exhaustive enumeration. The paper should state that
   the mechanized result is: **I2 holds under A4-as-assumption** (a monitor
   acts before the refund), not that fairness of the monitor was itself
   verified.
3. A corollary of choice 2: with `MONITOR = TRUE`, if the monitor never fires,
   the source lock simply remains `LOCKED` past `Te` (funds temporarily stuck,
   never double-spent). Safety is preserved; releasing the lock is exactly the
   monitor's liveness obligation under A4.
4. The minimal counterexample found by BFS (below) does **not** even need an
   explicit drop: mere delay of the callback past `Te` suffices
   (`cbInFlight = TRUE`, `cbDropped = FALSE` throughout). Explicit-drop
   variants of the violation exist deeper in the state graph.

## Summary table

| Configuration | Constants | Result | States generated | Distinct states | Depth |
|---|---|---|---|---|---|
| `MC_NoMonitor.cfg` | Tc=4, Te=6, MaxT=8, MONITOR=FALSE | **I2 VIOLATED** (trace below) | 247 | 105 (search stopped at violation) | 11 |
| `MC_Monitor.cfg` | Tc=4, Te=6, MaxT=8, MONITOR=TRUE | No error (TypeOK, I1, I2, I3 hold) | 408 | 145 (exhaustive) | 15 |
| `MC_NoMonitor_I1I3.cfg` | Tc=4, Te=6, MaxT=8, MONITOR=FALSE, I2 removed | No error (TypeOK, I1, I3 hold exhaustively) | 428 | 157 (exhaustive) | 15 |
| `MC_NoMonitor_Tc3Te5.cfg` | Tc=3, Te=5, MaxT=8, MONITOR=FALSE | **I2 VIOLATED** (10-state trace, same shape) | 212 | 93 (search stopped at violation) | 10 |
| `MC_Monitor_Tc3Te5.cfg` | Tc=3, Te=5, MaxT=8, MONITOR=TRUE | No error (all four hold) | 428 | 153 (exhaustive) | 15 |

The auxiliary run `MC_NoMonitor_I1I3.cfg` exists because a run that halts on
the I2 violation cannot certify I1/I3 over the *full* state space; with I2
removed, TLC explores all 157 reachable states of the no-monitor regime and
finds no violation of TypeOK, I1, or I3. For the exhaustive runs TLC reports
an optimistic fingerprint-collision probability of 2.1E-15 (effectively exact
for this state space).

## Counterexample trace for I2 (`MC_NoMonitor.cfg`) — verbatim TLC output

Scenario: user locks at t=0, prepare is delivered, user claims the mint at t=0
(< Tc=4), publishing the secret and emitting the callback; the relay delays
the callback indefinitely (never delivered, never explicitly dropped); the
clock reaches t=6 (= Te) and the user refunds the source lock. Final state:
`sigmaS = "REFUNDED"` and `sigmaD = "MINTED"` — unbacked supply.

```
Error: Invariant I2 is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\ prepInFlight = FALSE
/\ cbDropped = FALSE
/\ t = 0
/\ sigmaD = "NONE"
/\ prepDropped = FALSE
/\ lockEverExisted = FALSE
/\ cbInFlight = FALSE
/\ sigmaS = "NONE"

State 2: <LockForBurn line 90, col 5 to line 94, col 66 of module HTLCCallback>
/\ prepInFlight = TRUE
/\ cbDropped = FALSE
/\ t = 0
/\ sigmaD = "NONE"
/\ prepDropped = FALSE
/\ lockEverExisted = TRUE
/\ cbInFlight = FALSE
/\ sigmaS = "LOCKED"

State 3: <RelayDeliverPrepare line 103, col 5 to line 107, col 59 of module HTLCCallback>
/\ prepInFlight = TRUE
/\ cbDropped = FALSE
/\ t = 0
/\ sigmaD = "PENDING"
/\ prepDropped = FALSE
/\ lockEverExisted = TRUE
/\ cbInFlight = FALSE
/\ sigmaS = "LOCKED"

State 4: <ClaimMint line 121, col 5 to line 126, col 47 of module HTLCCallback>
/\ prepInFlight = TRUE
/\ cbDropped = FALSE
/\ t = 0
/\ sigmaD = "MINTED"
/\ prepDropped = FALSE
/\ lockEverExisted = TRUE
/\ cbInFlight = TRUE
/\ sigmaS = "LOCKED"

State 5: <Tick line 181, col 5 to line 184, col 59 of module HTLCCallback>
/\ prepInFlight = TRUE
/\ cbDropped = FALSE
/\ t = 1
/\ sigmaD = "MINTED"
/\ prepDropped = FALSE
/\ lockEverExisted = TRUE
/\ cbInFlight = TRUE
/\ sigmaS = "LOCKED"

State 6: <Tick line 181, col 5 to line 184, col 59 of module HTLCCallback>
/\ prepInFlight = TRUE
/\ cbDropped = FALSE
/\ t = 2
/\ sigmaD = "MINTED"
/\ prepDropped = FALSE
/\ lockEverExisted = TRUE
/\ cbInFlight = TRUE
/\ sigmaS = "LOCKED"

State 7: <Tick line 181, col 5 to line 184, col 59 of module HTLCCallback>
/\ prepInFlight = TRUE
/\ cbDropped = FALSE
/\ t = 3
/\ sigmaD = "MINTED"
/\ prepDropped = FALSE
/\ lockEverExisted = TRUE
/\ cbInFlight = TRUE
/\ sigmaS = "LOCKED"

State 8: <Tick line 181, col 5 to line 184, col 59 of module HTLCCallback>
/\ prepInFlight = TRUE
/\ cbDropped = FALSE
/\ t = 4
/\ sigmaD = "MINTED"
/\ prepDropped = FALSE
/\ lockEverExisted = TRUE
/\ cbInFlight = TRUE
/\ sigmaS = "LOCKED"

State 9: <Tick line 181, col 5 to line 184, col 59 of module HTLCCallback>
/\ prepInFlight = TRUE
/\ cbDropped = FALSE
/\ t = 5
/\ sigmaD = "MINTED"
/\ prepDropped = FALSE
/\ lockEverExisted = TRUE
/\ cbInFlight = TRUE
/\ sigmaS = "LOCKED"

State 10: <Tick line 181, col 5 to line 184, col 59 of module HTLCCallback>
/\ prepInFlight = TRUE
/\ cbDropped = FALSE
/\ t = 6
/\ sigmaD = "MINTED"
/\ prepDropped = FALSE
/\ lockEverExisted = TRUE
/\ cbInFlight = TRUE
/\ sigmaS = "LOCKED"

State 11: <RefundBurn line 172, col 5 to line 177, col 59 of module HTLCCallback>
/\ prepInFlight = TRUE
/\ cbDropped = FALSE
/\ t = 6
/\ sigmaD = "MINTED"
/\ prepDropped = FALSE
/\ lockEverExisted = TRUE
/\ cbInFlight = TRUE
/\ sigmaS = "REFUNDED"

247 states generated, 105 distinct states found, 17 states left on queue.
The depth of the complete state graph search is 11.
```

The Tc=3/Te=5 counterexample is analogous (10 states: LockForBurn,
RelayDeliverPrepare, ClaimMint at t=0, five Ticks to t=5, RefundBurn); see
`logs/MC_NoMonitor_Tc3Te5.log`.

## LaTeX-ready summary paragraph

```latex
We mechanized the single-instance protocol in \TLA+ and checked it
exhaustively with TLC (build 2026.03.02) under all interleavings of the
contracts, the clock, and a faulty relay that may delay, drop, or duplicate
messages ($T_c{=}4$, $T_e{=}6$, clock bound $8$; results are qualitatively
identical for $T_c{=}3$, $T_e{=}5$). Without assumption~A4, TLC refutes
supply conservation (I2), exhibiting an 11-state counterexample after
exploring 105 distinct states: the user claims the mint before $T_c$,
revealing the secret, the relay withholds the callback, and the user refunds
the source lock at $T_e$, yielding $\sigma_s{=}\textsc{Refunded} \wedge
\sigma_d{=}\textsc{Minted}$. With A4 modeled as an oracle assumption on the
refund guard---whenever the secret is public, a monitor claims the source
lock before any user refund executes---TLC exhaustively enumerates all 145
reachable states and finds no violation: I1 (single settlement, checked as an
action property that also certifies duplicate deliveries are no-ops), I2, and
I3 (semantic preservation via a lock-history variable) all hold. I1 and I3
also hold exhaustively without A4 (157 distinct states). We note that A4 is
encoded as an assumption rather than derived from scheduler fairness;
establishing that the monitor eventually acts is a liveness obligation
outside the scope of this safety check.
```
