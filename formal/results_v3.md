# TLC results — HTLCCallback_v3 (secret modelled as an event of its own)

Same tool and settings as results.md (TLC2 2026.03.02, BFS, 1 worker,
CHECK_DEADLOCK FALSE). Constants in every configuration: Tc = 4, Te = 6
(Tc = 3, Te = 5 in *_Tc3Te5), MaxT = 8; classes {cA, cB}; identities
{iA, iB, iX}; amounts {1, 2}; one transfer; one global clock.

Change w.r.t. v2: `secretPub` is a variable; `UserClaim` publishes S whatever
its outcome (mint only if sigmaD = PENDING and t < Tc); MonitorClaimBurn and
the callback are enabled by secretPub. New constant TIMELY = assumption A9
(the user only reveals S when the claim will land). New invariant NoLoss
(never CLAIMED at the source with the destination REFUNDED_D, or NONE with
the prepare lost). New liveness check L1 under weak fairness.

| Config | Assumptions dropped | Checked | Distinct states | Depth | Result |
|---|---|---|---|---|---|
| MC3_Base | none | TypeOK NoLoss I2 I3a I3b I3c NoStuckEscrow, I1 | 505 | 15 | holds |
| MC3_Base_Tc3Te5 | none | same | 521 | 15 | holds |
| MC3_NoMonitor | A4 | I2, I1 | 360 | 11 | I2 violated |
| MC3_NoMonitor_Rest | A4 | NoLoss I3a I3b I3c, I1 | 601 | 15 | holds |
| MC3_Forge_I3a | A6 | I3a | 161 | 5 | I3a violated |
| MC3_Forge_I3b | A6 | I3b | 173 | 5 | I3b violated |
| MC3_Forge_Rest | A6 | NoLoss I2 I3c NoStuckEscrow, I1 | 10185 | 17 | holds |
| MC3_NoA8_I3a | A8 | I3a | 26 | 4 | I3a violated |
| MC3_NoA8_Rest | A8 | NoLoss I2 I3b I3c NoStuckEscrow, I1 | 505 | 15 | holds |
| MC3_NoA9 | A9 | NoLoss | 67 | 5 | NoLoss violated |
| MC3_NoA9_Late | A9 | NoLossLate | 474 | 10 | violated |
| MC3_NoA9_Rest | A9 | I2 I3a I3b I3c, I1 | 945 | 15 | holds |
| MC3_Live | none (FairSpec) | L1 | 505 | 15 | holds |
| MC3_Live_NoA4 | A4 (FairSpec) | L1 | 601 | 15 | holds |

With A9 in force the nine original configurations reproduce exactly the
state counts, depths and verdicts of v2 (results.md).

Shortest NoLoss counterexample (MC3_NoA9, 5 states): LockForBurn ->
RelayDropPrepare -> UserClaim at t = 0 with sigmaD = NONE (fails, S public)
-> MonitorClaimBurn (sigmaS = CLAIMED). The asset is burned at the source and
never minted.

Late-claim counterexample (MC3_NoA9_Late, 10 states): lock, prepare
delivered (PENDING), clock reaches t = Tc = 4, UserClaim fails (t >= Tc) but
publishes S, MonitorClaimBurn burns the escrow, RefundMint -> REFUNDED_D.

Note: without A9, NoStuckEscrow is also violated (MC3_NoA9_Stuck): S
published after Te, when the model's monitor (conservatively restricted to
t < Te) can no longer act. This is an artefact of that conservative guard;
in the deployment claimBurn has no time limit.
