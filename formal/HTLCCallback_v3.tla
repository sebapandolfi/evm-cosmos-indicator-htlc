--------------------------- MODULE HTLCCallback_v3 ---------------------------
(***************************************************************************)
(* TLA+ model of a single instance of the cross-chain HTLC-with-callback    *)
(* protocol (one transfer, identified by its hashlock H).                  *)
(*                                                                         *)
(* VERSION 3 (this file).  One change with respect to version 2 (kept      *)
(* verbatim below for reference): the SECRET IS MODELLED AS A PUBLIC       *)
(* EVENT OF ITS OWN.  Version 2 identified "S is public" with sigmaD =     *)
(* MINTED.  In the deployment, S becomes public as soon as the user        *)
(* submits claim_mint, whether or not that transaction succeeds (a         *)
(* reverted Cosmos transaction is still included in a block with its       *)
(* arguments, and the mempool is public).  Since claimBurn at the source    *)
(* only checks keccak256(S) = H, a claim that is attempted too late        *)
(* (t >= Tc) or before the prepare has arrived publishes S without a mint. *)
(* Version 3 adds the variable secretPub, a user action UserClaim that     *)
(* sets it whatever the outcome, the invariant NoLoss (the asset is never  *)
(* burned at the source while the destination ends without a mint) and an  *)
(* environment assumption A9 (TIMELY): the user only reveals S while the   *)
(* destination mint is PENDING and t < Tc, in which case the claim lands.  *)
(*                                                                         *)
(* VERSION 2.  Two changes with respect to version 1, both motivated by an  *)
(* audit of the logic of the verification itself.                           *)
(*                                                                         *)
(* (1) THE SEMANTIC PAYLOAD IS NOW MODELLED.  Version 1 had neither classes *)
(*     nor amounts, so its "semantic preservation" invariant degenerated to  *)
(*     "a mint was preceded by a lock" -- a structural consequence of the    *)
(*     transition relation, and therefore vacuous as evidence.  This        *)
(*     version carries a class, a class IDENTITY and an amount through the  *)
(*     whole flow: the source escrow records the class and amount, the      *)
(*     prepare message transports the identity (derived on-chain from the   *)
(*     class profile) and the amount, and the destination resolves the      *)
(*     identity against its own class registry before minting.  The         *)
(*     preservation invariants I3a/I3b/I3c are consequently falsifiable,    *)
(*     and are in fact falsified in the regimes where the corresponding     *)
(*     assumption is dropped.                                              *)
(*                                                                         *)
(* (2) A4 IS AN ASSUMPTION ON THE ENVIRONMENT, NOT A GUARD ON THE CONTRACT. *)
(*     Version 1 encoded the rational-monitor assumption by adding the      *)
(*     conjunct sigmaD /= "MINTED" to RefundBurn.  That conditions a        *)
(*     source-chain action on destination-chain state -- exactly the        *)
(*     information the source contract cannot observe, and the reason the   *)
(*     callback exists -- so the model was not the real system under an     *)
(*     assumption but a different system.  It also admitted a state that A4 *)
(*     excludes: with the callback dropped and the monitor never scheduled, *)
(*     the escrow stayed LOCKED forever, a liveness failure invisible to    *)
(*     safety invariants.  Here RefundBurn keeps its faithful guard (source *)
(*     state and clock only) and A4 constrains the CLOCK: it may not cross  *)
(*     Te while a monitor is pending.  That is precisely "some monitor acts *)
(*     before Te", it leaves the contract untouched, and it admits no stuck *)
(*     escrow (see NoStuckEscrow).                                         *)
(*                                                                         *)
(* FIDELITY TO THE DEPLOYED CONTRACTS.  The model was checked line by line  *)
(* against BridgeHTLC.sol, IndicatorToken1155.sol and the CosmWasm          *)
(* contract.  Three deliberate divergences remain, all conservative:        *)
(*                                                                         *)
(*   (i)  MonitorClaimBurn requires t < Te; the contracts' claimBurn /      *)
(*        execute_claim_burn impose NO time condition -- the monitor may    *)
(*        act at any point while the escrow is still LOCKED, even past Te.  *)
(*        The model is therefore STRICTER than the deployment, which means  *)
(*        A4 can be weakened in the real system to "some monitor acts       *)
(*        before the user's refund lands" rather than "before Te".  Either  *)
(*        way I2 holds, because LOCKED -> CLAIMED and LOCKED -> REFUNDED    *)
(*        are mutually exclusive transitions out of the same state.         *)
(*                                                                         *)
(*   (ii) The model omits two guards the contracts enforce: the minimum     *)
(*        timelock duration on lockForBurn (1 hour) and the restriction of  *)
(*        refundBurn to the original sender.  Both only remove behaviours,  *)
(*        so an invariant proved here holds a fortiori on the deployment.   *)
(*                                                                         *)
(*   (iii) The model resolves the destination class BY IDENTITY, whereas    *)
(*        the contract resolves it by local token id and then checks the    *)
(*        identities match.  Equivalent containment: in both, a forged      *)
(*        message must be internally consistent with the destination        *)
(*        registry, so it can redirect to another REGISTERED class but not  *)
(*        to one absent from the registry.                                  *)
(*                                                                         *)
(*   (iv) Two minor ones.  The prepare guard is modelled only as to class   *)
(*        identity -- the contracts also check that the claim deadline has  *)
(*        not passed and that the recipient is well formed; both only       *)
(*        remove behaviours.  And failed delivery is modelled as a no-op,   *)
(*        which is literally what the EVM side does (CallbackIgnored, then  *)
(*        return), whereas the CosmWasm side returns Err and reverts.  On   *)
(*        contract state both are no-ops, so the abstraction is faithful;   *)
(*        what differs is what the relay observes, which is out of scope.   *)
(*                                                                         *)
(* A8 was confirmed exactly: IndicatorToken1155.createTokenClass derives    *)
(* indicatorId = keccak256(profileHash) on-chain, while the CosmWasm        *)
(* execute_create_token_class stores the indicator_id it receives and never *)
(* hashes profile_hash.  The mirrored-registry assumption is therefore a    *)
(* real property of the deployment, not an artefact of this model.          *)
(*                                                                         *)
(* Regime constants:                                                        *)
(*   MONITOR     : assumption A4 (a bounty-incented monitor acts before Te) *)
(*   FORGE       : the relay may tamper with the prepare message.           *)
(*                 FORGE = TRUE models the negation of A6 (honest relay).   *)
(*   REGISTRY_OK : assumption A8 (the owner mirrors class identities        *)
(*                 consistently on both chains).  REGISTRY_OK = FALSE binds *)
(*                 a destination class to an identity other than the one    *)
(*                 the source derives for it.                              *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Tc,          \* destination claim deadline (claim allowed only at t < Tc)
    Te,          \* source refund deadline (refund allowed only at t >= Te)
    MaxT,        \* clock bound (finite-state model)
    MONITOR,     \* BOOLEAN: assumption A4 in force?
    FORGE,       \* BOOLEAN: relay may forge messages (negation of A6)?
    REGISTRY_OK, \* BOOLEAN: assumption A8 in force?
    TIMELY       \* BOOLEAN: assumption A9 (timely revelation) in force?

ASSUME /\ Tc \in Nat \ {0}
       /\ Te \in Nat
       /\ MaxT \in Nat
       /\ Tc < Te
       /\ Te <= MaxT
       /\ MONITOR \in BOOLEAN
       /\ FORGE \in BOOLEAN
       /\ REGISTRY_OK \in BOOLEAN
       /\ TIMELY \in BOOLEAN

(*************************************************************************)
(* Classes, identities and the two registries.                            *)
(*                                                                        *)
(* Classes are the local asset classes; identities are the content-        *)
(* addressed class identifiers (keccak of the profile commitment).  Two    *)
(* classes and a third, unregistered identity iX suffice to expose both    *)
(* class mixing and minting under an unknown identity.                     *)
(*                                                                        *)
(* SrcId is computed ON-CHAIN at the source, so it is a fixed function of  *)
(* the class.  DstClass is the destination registry, which the contract    *)
(* STORES as given by the owner without recomputing the derivation; that   *)
(* is why its consistency with SrcId is an assumption (A8) and not a       *)
(* cryptographic fact.  With REGISTRY_OK = FALSE the owner has registered  *)
(* the destination class cA under the identity of cB, which is the         *)
(* concrete way A8 fails.                                                 *)
(*************************************************************************)
Classes  == {"cA", "cB"}
Ids      == {"iA", "iB", "iX"}
Amounts  == {1, 2}
NoTok    == "none"
NoId     == "noid"
NoAmt    == 0

SrcId(c)   == IF c = "cA" THEN "iA" ELSE "iB"
DstReg     == {"iA", "iB"}          \* identities registered at the destination
DstClass(i) == CASE i = "iA" -> "cA"
                 [] i = "iB" -> IF REGISTRY_OK THEN "cB" ELSE "cA"
                 [] OTHER    -> NoTok

-----------------------------------------------------------------------------
VARIABLES
    sigmaS,          \* source-chain lock state
    sigmaD,          \* destination-chain mint state
    t,               \* discrete global clock
    srcTok, srcAmt,  \* class and amount actually escrowed at the source
    msgId,  msgAmt,  \* class identity and amount carried by the message
    dstTok, dstAmt,  \* class and amount actually minted at the destination
    dstId,           \* identity under which the destination accepted the mint
    prepInFlight,
    prepDropped,
    cbInFlight,
    cbDropped,
    secretPub        \* the secret S has been published (mempool or block)

vars == <<sigmaS, sigmaD, t, srcTok, srcAmt, msgId, msgAmt,
          dstTok, dstAmt, dstId, prepInFlight, prepDropped,
          cbInFlight, cbDropped, secretPub>>

SourceStates == {"NONE", "LOCKED", "CLAIMED", "REFUNDED"}
DestStates   == {"NONE", "PENDING", "MINTED", "REFUNDED_D"}
TerminalS    == {"CLAIMED", "REFUNDED"}
TerminalD    == {"MINTED", "REFUNDED_D"}

SecretPublic   == secretPub
MonitorPending == MONITOR /\ SecretPublic /\ sigmaS = "LOCKED"

-----------------------------------------------------------------------------
Init == /\ sigmaS = "NONE"
        /\ sigmaD = "NONE"
        /\ t = 0
        /\ srcTok = NoTok /\ srcAmt = NoAmt
        /\ msgId  = NoId  /\ msgAmt = NoAmt
        /\ dstTok = NoTok /\ dstAmt = NoAmt /\ dstId = NoId
        /\ prepInFlight = FALSE
        /\ prepDropped  = FALSE
        /\ cbInFlight   = FALSE
        /\ cbDropped    = FALSE
        /\ secretPub    = FALSE

-----------------------------------------------------------------------------
(* Action 1: the user escrows an amount of a class; the bridge emits the    *)
(* prepare message.  The identity travelling in the message is read         *)
(* on-chain from the class registry, never from user input, hence SrcId.    *)
LockForBurn ==
    /\ sigmaS = "NONE"
    /\ \E c \in Classes, a \in Amounts :
         /\ srcTok' = c /\ srcAmt' = a
         /\ msgId'  = SrcId(c) /\ msgAmt' = a
    /\ sigmaS' = "LOCKED"
    /\ prepInFlight' = TRUE
    /\ UNCHANGED <<sigmaD, t, dstTok, dstAmt, dstId,
                   prepDropped, cbInFlight, cbDropped, secretPub>>

(* Action 2: the relay delivers the prepare message.  The destination opens *)
(* a PENDING mint only if the identity carried by the message is registered *)
(* in its own class registry; the class minted is the one the registry      *)
(* resolves that identity to.  The message stays in flight after delivery,  *)
(* which models duplicate delivery; delivery to a non-NONE destination is a *)
(* no-op.                                                                  *)
RelayDeliverPrepare ==
    /\ prepInFlight
    /\ ~prepDropped
    /\ IF sigmaD = "NONE" /\ msgId \in DstReg
         THEN /\ sigmaD' = "PENDING"
              /\ dstTok' = DstClass(msgId)
              /\ dstAmt' = msgAmt
              /\ dstId'  = msgId
         ELSE UNCHANGED <<sigmaD, dstTok, dstAmt, dstId, secretPub>>
    /\ UNCHANGED <<sigmaS, t, srcTok, srcAmt, msgId, msgAmt,
                   prepInFlight, prepDropped, cbInFlight, cbDropped, secretPub>>

RelayDropPrepare ==
    /\ prepInFlight
    /\ ~prepDropped
    /\ prepDropped' = TRUE
    /\ UNCHANGED <<sigmaS, sigmaD, t, srcTok, srcAmt, msgId, msgAmt,
                   dstTok, dstAmt, dstId, prepInFlight, cbInFlight, cbDropped, secretPub>>

(* Action 2b: a BYZANTINE relay tampers with the prepare message.  Enabled  *)
(* only when FORGE is TRUE, i.e. when assumption A6 is dropped.             *)
RelayForgePrepare ==
    /\ FORGE
    /\ prepInFlight
    /\ ~prepDropped
    /\ \E i \in Ids, a \in Amounts :
         /\ <<i, a>> /= <<msgId, msgAmt>>
         /\ msgId' = i /\ msgAmt' = a
    /\ UNCHANGED <<sigmaS, sigmaD, t, srcTok, srcAmt, dstTok, dstAmt, dstId,
                   prepInFlight, prepDropped, cbInFlight, cbDropped, secretPub>>

(* Action 3: the user submits claim_mint, which PUBLISHES the secret       *)
(* whatever its outcome.  The mint (and the callback) happen only if the    *)
(* destination is PENDING and t < Tc; otherwise the transaction reverts on  *)
(* contract state, but S is public.  Under A9 (TIMELY) the user submits it  *)
(* only when it will land.  The user may retry while the claim is still     *)
(* possible.                                                              *)
ClaimOK == sigmaD = "PENDING" /\ t < Tc
UserClaim ==
    /\ sigmaS # "NONE"
    /\ sigmaD \in {"NONE", "PENDING"}
    /\ (TIMELY => ClaimOK)
    /\ secretPub' = TRUE
    /\ IF ClaimOK
         THEN /\ sigmaD' = "MINTED"
              /\ cbInFlight' = TRUE
         ELSE UNCHANGED <<sigmaD, cbInFlight>>
    /\ UNCHANGED <<sigmaS, t, srcTok, srcAmt, msgId, msgAmt,
                   dstTok, dstAmt, dstId, prepInFlight, prepDropped, cbDropped>>

(* Action 4: the relay delivers the callback and the source escrow burns.   *)
RelayDeliverCallback ==
    /\ cbInFlight
    /\ ~cbDropped
    /\ sigmaS' = IF sigmaS = "LOCKED" THEN "CLAIMED" ELSE sigmaS
    /\ UNCHANGED <<sigmaD, t, srcTok, srcAmt, msgId, msgAmt,
                   dstTok, dstAmt, dstId, prepInFlight, prepDropped,
                   cbInFlight, cbDropped, secretPub>>

RelayDropCallback ==
    /\ cbInFlight
    /\ ~cbDropped
    /\ cbDropped' = TRUE
    /\ UNCHANGED <<sigmaS, sigmaD, t, srcTok, srcAmt, msgId, msgAmt,
                   dstTok, dstAmt, dstId, prepInFlight, prepDropped, cbInFlight, secretPub>>

(* Action 5: a monitor observes the published secret and finalises the      *)
(* source-side burn itself, before the refund deadline.                     *)
MonitorClaimBurn ==
    /\ MONITOR
    /\ SecretPublic
    /\ sigmaS = "LOCKED"
    /\ t < Te
    /\ sigmaS' = "CLAIMED"
    /\ UNCHANGED <<sigmaD, t, srcTok, srcAmt, msgId, msgAmt,
                   dstTok, dstAmt, dstId, prepInFlight, prepDropped,
                   cbInFlight, cbDropped, secretPub>>

(* Action 6: an unclaimed pending mint is refunded after the claim deadline. *)
RefundMint ==
    /\ sigmaD = "PENDING"
    /\ t >= Tc
    /\ sigmaD' = "REFUNDED_D"
    /\ UNCHANGED <<sigmaS, t, srcTok, srcAmt, msgId, msgAmt,
                   dstTok, dstAmt, dstId, prepInFlight, prepDropped,
                   cbInFlight, cbDropped, secretPub>>

(* Action 7: the user refunds the source escrow after the refund deadline.  *)
(* NOTE: the guard mentions only source-chain state and the clock, exactly  *)
(* as the deployed contract does.  It does NOT consult destination state.   *)
RefundBurn ==
    /\ sigmaS = "LOCKED"
    /\ t >= Te
    /\ sigmaS' = "REFUNDED"
    /\ UNCHANGED <<sigmaD, t, srcTok, srcAmt, msgId, msgAmt,
                   dstTok, dstAmt, dstId, prepInFlight, prepDropped,
                   cbInFlight, cbDropped, secretPub>>

(* Action 8: the clock advances.  Assumption A4 lives HERE, as a constraint *)
(* on the environment: the clock may not cross Te while a monitor is        *)
(* pending, which is exactly "some monitor acts before Te".  With           *)
(* MONITOR = FALSE the conjunct is vacuous and the clock runs freely.       *)
Tick ==
    /\ t < MaxT
    /\ ~(MonitorPending /\ t + 1 = Te)
    /\ t' = t + 1
    /\ UNCHANGED <<sigmaS, sigmaD, srcTok, srcAmt, msgId, msgAmt,
                   dstTok, dstAmt, dstId, prepInFlight, prepDropped,
                   cbInFlight, cbDropped, secretPub>>

-----------------------------------------------------------------------------
Next == \/ LockForBurn
        \/ RelayDeliverPrepare
        \/ RelayDropPrepare
        \/ RelayForgePrepare
        \/ UserClaim
        \/ RelayDeliverCallback
        \/ RelayDropCallback
        \/ MonitorClaimBurn
        \/ RefundMint
        \/ RefundBurn
        \/ Tick

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
TypeOK == /\ sigmaS \in SourceStates
          /\ sigmaD \in DestStates
          /\ t \in 0..MaxT
          /\ srcTok \in Classes \cup {NoTok}
          /\ dstTok \in Classes \cup {NoTok}
          /\ msgId  \in Ids \cup {NoId}
          /\ dstId  \in Ids \cup {NoId}
          /\ srcAmt \in Amounts \cup {NoAmt}
          /\ dstAmt \in Amounts \cup {NoAmt}
          /\ msgAmt \in Amounts \cup {NoAmt}
          /\ prepInFlight \in BOOLEAN
          /\ prepDropped  \in BOOLEAN
          /\ cbInFlight   \in BOOLEAN
          /\ cbDropped    \in BOOLEAN
          /\ secretPub    \in BOOLEAN

(* I1 -- single settlement: terminal states are absorbing. *)
I1 == [][ /\ (sigmaS \in TerminalS => sigmaS' = sigmaS)
          /\ (sigmaD \in TerminalD => sigmaD' = sigmaD) ]_vars

(* I2 -- supply conservation. *)
I2 == ~(sigmaS = "REFUNDED" /\ sigmaD = "MINTED")

(* I3a -- CLASS preservation: any mint is of a class whose identity is the  *)
(* identity of the class actually escrowed at the source.                   *)
I3a == sigmaD = "MINTED" => /\ srcTok \in Classes
                            /\ dstTok \in Classes
                            /\ SrcId(srcTok) = SrcId(dstTok)

(* I3b -- AMOUNT preservation: the minted amount equals the escrowed one.   *)
I3b == sigmaD = "MINTED" => dstAmt = srcAmt

(* I3c -- LOCAL admissibility: the destination never opened a mint under an *)
(* identity absent from its own class registry.  This is the part of        *)
(* preservation the destination contract enforces unilaterally, without    *)
(* trusting the relay.                                                     *)
I3c == sigmaD \in {"PENDING", "MINTED"} => dstId \in DstReg

(* NoStuckEscrow -- liveness sanity check on the encoding of A4: the escrow *)
(* is never left outstanding at the clock bound with the secret public.     *)
(* Version 1 violated this; it is the artefact that motivated change (2).   *)
NoStuckEscrow == ~(sigmaS = "LOCKED" /\ SecretPublic /\ t = MaxT)

(* NoLoss (new in v3) -- the asset is never destroyed on both sides: the    *)
(* source escrow is not burned while the destination ends without a mint, *)
(* either refunded or with the prepare lost for good.                      *)
NoLoss == sigmaS = "CLAIMED" =>
            /\ sigmaD # "REFUNDED_D"
            /\ ~(sigmaD = "NONE" /\ prepDropped)

(* NoLossLate -- the clause of NoLoss for a claim that arrives too late.    *)
NoLossLate == ~(sigmaS = "CLAIMED" /\ sigmaD = "REFUNDED_D")

(* Weak fairness for the liveness check: every enabled protocol step that  *)
(* some party is incentivised to take eventually happens.                   *)
Fairness == /\ WF_vars(RelayDeliverPrepare) /\ WF_vars(RelayDeliverCallback)
            /\ WF_vars(MonitorClaimBurn) /\ WF_vars(RefundMint)
            /\ WF_vars(RefundBurn) /\ WF_vars(Tick)
FairSpec == Spec /\ Fairness

(* L1 -- the source escrow is eventually settled one way or the other.     *)
L1 == (sigmaS = "LOCKED") ~> (sigmaS \in TerminalS)

=============================================================================
