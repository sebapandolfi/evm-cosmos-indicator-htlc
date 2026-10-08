# Archive — version 1 of the TLA+ model

This directory holds the **first version** of `HTLCCallback.tla`, its five
configurations, its logs and its `results.md`. It is kept for provenance: the
figures reported in the earlier draft of the thesis and in the article came
from these runs. **It is superseded by the v2 spec in the parent directory and
should not be cited.**

An audit of the verification logic (not of the protocol) found two defects in
this version. Both are fixed in v2, and the fixes changed what the model
checker actually establishes.

## Defect 1 — the semantic-preservation invariant was vacuous

Version 1 modelled no classes and no amounts. Its invariant

```tla
I3 == sigmaD = "MINTED" => lockEverExisted
```

therefore says only "a mint was preceded by a lock", which is a **structural
consequence of the transition relation**: `MINTED` is reachable only via
`PENDING`, `PENDING` only via delivery of the prepare message, and the prepare
message is emitted only by `LockForBurn`. A probe invariant confirmed the
weaker form holds across all 157 reachable states of the no-monitor regime by
construction. The invariant is true, but it is not evidence about semantic
preservation: it cannot express "the same amount, of a class with the same
identity", because the state space contains neither.

v2 carries a class, a content-addressed class identity and an amount through
the whole flow, and splits the property into three falsifiable invariants
(`I3a` class, `I3b` amount, `I3c` local admissibility). Two of them are in fact
refuted when the corresponding assumption is dropped.

## Defect 2 — assumption A4 was encoded as a guard on the contract

Version 1 modelled the rational-monitor assumption by adding a conjunct to the
refund action:

```tla
RefundBurn ==
    /\ sigmaS = "LOCKED"
    /\ t >= Te
    /\ (MONITOR => sigmaD /= "MINTED")   \* <- oracle abstraction of A4
    ...
```

That conjunct conditions a **source-chain** action on **destination-chain**
state — precisely the information the source contract cannot observe, and the
whole reason the callback mechanism exists. With the guard in place the model
is not the deployed system under an assumption; it is a different system, one
that could not be implemented.

The encoding also admitted a state that A4 is supposed to exclude. Probing v1
with

```tla
NoStuckEscrow == ~(sigmaS = "LOCKED" /\ sigmaD = "MINTED"
                   /\ cbDropped /\ t = MaxT)
```

produced a 13-state violation: the callback is dropped, the monitor is never
scheduled before `Te`, and the refund is then blocked by the guard forever, so
the escrow is **permanently immobilised**. None of the three invariants detects
it, because all three are safety properties and an immobilised escrow is a
liveness failure. (Note also that `results.md` in this directory calls those
funds "temporarily stuck"; in the model the condition is permanent.)

v2 restores the faithful refund guard — source state and clock only — and
expresses A4 where it belongs, as a constraint on the **environment**: the
clock may not cross `Te` while a monitor is pending, which is exactly the
statement "some monitor acts before `Te`". `NoStuckEscrow` is verified and
holds in every regime where A4 is in force.
