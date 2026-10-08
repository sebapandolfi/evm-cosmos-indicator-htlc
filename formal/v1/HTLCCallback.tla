---------------------------- MODULE HTLCCallback ----------------------------
(***************************************************************************)
(* TLA+ model of a single instance of the cross-chain HTLC-with-callback  *)
(* protocol (one transfer, identified by its hashlock H).                 *)
(*                                                                         *)
(* The model comprises:                                                    *)
(*   - a source-chain lock contract with state sigmaS in                   *)
(*     {NONE, LOCKED, CLAIMED, REFUNDED};                                  *)
(*   - a destination-chain mint contract with state sigmaD in              *)
(*     {NONE, PENDING, MINTED, REFUNDED_D};                                *)
(*   - a discrete global clock t in 0..MaxT with two deadlines             *)
(*     Tc < Te (destination claim deadline and source refund deadline);    *)
(*   - a faulty relay carrying a "prepare" message on the forward channel  *)
(*     and a "callback" message (H, S) on the backward channel.  The relay *)
(*     may DELAY a message arbitrarily (delivery is simply never           *)
(*     scheduled), DROP it forever (explicit Drop actions), or DUPLICATE   *)
(*     delivery (a delivered message remains deliverable; re-delivery      *)
(*     must be -- and is verified to be -- a no-op on contract state).     *)
(*                                                                         *)
(* The constant MONITOR selects between two regimes:                       *)
(*   - MONITOR = FALSE: no third party observes the published secret; the  *)
(*     only way the source lock is claimed is delivery of the callback.    *)
(*   - MONITOR = TRUE: models assumption A4 (a rational, bounty-incented   *)
(*     monitor).  Two things change:                                       *)
(*       (a) the action MonitorClaimBurn becomes enabled whenever the      *)
(*           secret is public (sigmaD = MINTED), the source is still       *)
(*           LOCKED, and t < Te; and                                       *)
(*       (b) RefundBurn is additionally guarded by sigmaD /= MINTED.       *)
(*     Guard (b) is an ORACLE ABSTRACTION of A4: it encodes "some monitor  *)
(*     always claims the lock before the user's refund executes" as an     *)
(*     assumption rather than deriving it from fairness.  This keeps I2 a  *)
(*     pure safety property checkable by exhaustive enumeration.  Without  *)
(*     (b), the fact that the monitor eventually acts is a fairness        *)
(*     (liveness) hypothesis, and a safety check would still exhibit the   *)
(*     interleaving in which the monitor is never scheduled.  See the      *)
(*     accompanying results.md for discussion.                             *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Tc,      \* destination claim deadline (claim allowed only at t < Tc)
    Te,      \* source refund deadline (refund allowed only at t >= Te)
    MaxT,    \* clock bound (finite-state model)
    MONITOR  \* BOOLEAN: is assumption A4 (rational monitor) in force?

ASSUME /\ Tc \in Nat \ {0}
       /\ Te \in Nat
       /\ MaxT \in Nat
       /\ Tc < Te
       /\ Te <= MaxT
       /\ MONITOR \in BOOLEAN

VARIABLES
    sigmaS,          \* source-chain lock state
    sigmaD,          \* destination-chain mint state
    t,               \* discrete global clock
    prepInFlight,    \* prepare message has been emitted on the forward channel
    prepDropped,     \* relay has dropped the prepare message forever
    cbInFlight,      \* callback (H, S) has been emitted on the backward channel
    cbDropped,       \* relay has dropped the callback forever
    lockEverExisted  \* history variable: LockForBurn has occurred (for I3)

vars == <<sigmaS, sigmaD, t, prepInFlight, prepDropped,
          cbInFlight, cbDropped, lockEverExisted>>

SourceStates == {"NONE", "LOCKED", "CLAIMED", "REFUNDED"}
DestStates   == {"NONE", "PENDING", "MINTED", "REFUNDED_D"}
TerminalS    == {"CLAIMED", "REFUNDED"}     \* terminal source states
TerminalD    == {"MINTED", "REFUNDED_D"}    \* terminal destination states

\* The secret S becomes public exactly when the user claims on the
\* destination chain (the mint transaction reveals it).
SecretPublic == sigmaD = "MINTED"

-----------------------------------------------------------------------------
(* Initial state: nothing has happened yet. *)
Init == /\ sigmaS = "NONE"
        /\ sigmaD = "NONE"
        /\ t = 0
        /\ prepInFlight = FALSE
        /\ prepDropped  = FALSE
        /\ cbInFlight   = FALSE
        /\ cbDropped    = FALSE
        /\ lockEverExisted = FALSE

-----------------------------------------------------------------------------
(* Action 1: the user locks funds on the source chain, emitting the       *)
(* prepare message into the relay's forward channel.                      *)
LockForBurn ==
    /\ sigmaS = "NONE"
    /\ sigmaS' = "LOCKED"
    /\ prepInFlight' = TRUE
    /\ lockEverExisted' = TRUE
    /\ UNCHANGED <<sigmaD, t, prepDropped, cbInFlight, cbDropped>>

(* Action 2: the relay delivers the prepare message.  The message remains *)
(* in flight after delivery, so this action stays enabled and models      *)
(* DUPLICATE delivery attempts; the IF guard makes any delivery to a      *)
(* non-NONE destination a no-op (verified by the I1 action property).     *)
(* DELAY is modeled implicitly: the scheduler may simply never pick this  *)
(* action.                                                                *)
RelayDeliverPrepare ==
    /\ prepInFlight
    /\ ~prepDropped
    /\ sigmaD' = IF sigmaD = "NONE" THEN "PENDING" ELSE sigmaD
    /\ UNCHANGED <<sigmaS, t, prepInFlight, prepDropped,
                   cbInFlight, cbDropped, lockEverExisted>>

(* The relay DROPS the prepare message forever. *)
RelayDropPrepare ==
    /\ prepInFlight
    /\ ~prepDropped
    /\ prepDropped' = TRUE
    /\ UNCHANGED <<sigmaS, sigmaD, t, prepInFlight,
                   cbInFlight, cbDropped, lockEverExisted>>

(* Action 3: the user claims the mint on the destination chain before the *)
(* claim deadline Tc, revealing the secret S and emitting the callback    *)
(* (H, S) into the relay's backward channel.                              *)
ClaimMint ==
    /\ sigmaD = "PENDING"
    /\ t < Tc
    /\ sigmaD' = "MINTED"
    /\ cbInFlight' = TRUE
    /\ UNCHANGED <<sigmaS, t, prepInFlight, prepDropped,
                   cbDropped, lockEverExisted>>

(* Action 4: the relay delivers the callback; the source lock burns.      *)
(* As with the prepare message, the callback stays deliverable            *)
(* (duplication) and delivery to a non-LOCKED source is a no-op.          *)
RelayDeliverCallback ==
    /\ cbInFlight
    /\ ~cbDropped
    /\ sigmaS' = IF sigmaS = "LOCKED" THEN "CLAIMED" ELSE sigmaS
    /\ UNCHANGED <<sigmaD, t, prepInFlight, prepDropped,
                   cbInFlight, cbDropped, lockEverExisted>>

(* The relay DROPS the callback forever. *)
RelayDropCallback ==
    /\ cbInFlight
    /\ ~cbDropped
    /\ cbDropped' = TRUE
    /\ UNCHANGED <<sigmaS, sigmaD, t, prepInFlight, prepDropped,
                   cbInFlight, lockEverExisted>>

(* Action 5: a rational monitor (assumption A4) observes the published    *)
(* secret and claims the source lock itself, before the refund deadline.  *)
MonitorClaimBurn ==
    /\ MONITOR
    /\ SecretPublic
    /\ sigmaS = "LOCKED"
    /\ t < Te
    /\ sigmaS' = "CLAIMED"
    /\ UNCHANGED <<sigmaD, t, prepInFlight, prepDropped,
                   cbInFlight, cbDropped, lockEverExisted>>

(* Action 6: after the claim deadline, an unclaimed PENDING mint is       *)
(* refunded on the destination chain.                                     *)
RefundMint ==
    /\ sigmaD = "PENDING"
    /\ t >= Tc
    /\ sigmaD' = "REFUNDED_D"
    /\ UNCHANGED <<sigmaS, t, prepInFlight, prepDropped,
                   cbInFlight, cbDropped, lockEverExisted>>

(* Action 7: after the refund deadline, the user refunds the source lock. *)
(* When MONITOR = TRUE the extra conjunct sigmaD /= "MINTED" is the       *)
(* oracle abstraction of A4 described in the header comment: it asserts   *)
(* that if the secret is public, some monitor claims the lock before the  *)
(* user's refund can execute.                                             *)
RefundBurn ==
    /\ sigmaS = "LOCKED"
    /\ t >= Te
    /\ (MONITOR => sigmaD /= "MINTED")
    /\ sigmaS' = "REFUNDED"
    /\ UNCHANGED <<sigmaD, t, prepInFlight, prepDropped,
                   cbInFlight, cbDropped, lockEverExisted>>

(* Action 8: the global clock advances (bounded by MaxT). *)
Tick ==
    /\ t < MaxT
    /\ t' = t + 1
    /\ UNCHANGED <<sigmaS, sigmaD, prepInFlight, prepDropped,
                   cbInFlight, cbDropped, lockEverExisted>>

-----------------------------------------------------------------------------
Next == \/ LockForBurn
        \/ RelayDeliverPrepare
        \/ RelayDropPrepare
        \/ ClaimMint
        \/ RelayDeliverCallback
        \/ RelayDropCallback
        \/ MonitorClaimBurn
        \/ RefundMint
        \/ RefundBurn
        \/ Tick

(* Safety is checked under ALL interleavings: no fairness is assumed in   *)
(* Spec.  (Weak fairness on Tick/RefundBurn would only matter for         *)
(* liveness properties, which are not the object of this check.)          *)
Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Type invariant. *)
TypeOK == /\ sigmaS \in SourceStates
          /\ sigmaD \in DestStates
          /\ t \in 0..MaxT
          /\ prepInFlight \in BOOLEAN
          /\ prepDropped  \in BOOLEAN
          /\ cbInFlight   \in BOOLEAN
          /\ cbDropped    \in BOOLEAN
          /\ lockEverExisted \in BOOLEAN

(* I1 -- single settlement.  Terminal states are absorbing: no transition *)
(* (including duplicate relay deliveries) modifies a side that has        *)
(* already reached a terminal state.  Encoded as an action property and   *)
(* checked over every transition explored by TLC.                         *)
I1 == [][ /\ (sigmaS \in TerminalS => sigmaS' = sigmaS)
          /\ (sigmaD \in TerminalD => sigmaD' = sigmaD) ]_vars

(* I2 -- supply conservation.  It must never be the case that the mint    *)
(* succeeded on the destination while the backing funds were refunded on  *)
(* the source (double spend / unbacked supply).                           *)
I2 == ~(sigmaS = "REFUNDED" /\ sigmaD = "MINTED")

(* I3 -- semantic preservation.  A successful mint presupposes an         *)
(* authentic lock: MINTED is reachable only via PENDING, which is created *)
(* only by delivery of the prepare message, which is emitted only by      *)
(* LockForBurn.  lockEverExisted is the history variable recording that   *)
(* the lock occurred.                                                     *)
I3 == sigmaD = "MINTED" => lockEverExisted

=============================================================================
