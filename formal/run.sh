#!/usr/bin/env bash
# Run all TLC model-checking configurations for HTLCCallback.tla (v2).
# Requires: java (11+) and tla2tools.jar in this directory.
#
# TLC runs with a single worker so that BFS is deterministic and the
# state counts / counterexamples quoted in results.md are reproducible.
#
# Note on exit codes: TLC exits non-zero when it finds a violation. Four of
# the nine runs are EXPECTED to report a violation, each isolating the effect
# of dropping one assumption:
#
#   MC_NoMonitor  -> I2  violated  (drop A4: rational monitor)
#   MC_Forge_I3a  -> I3a violated  (drop A6: honest relay) - class clause
#   MC_Forge_I3b  -> I3b violated  (drop A6: honest relay) - amount clause
#   MC_NoA8_I3a   -> I3a violated  (drop A8: mirrored registry)
#
# The five remaining runs are expected to pass exhaustively; each certifies
# what SURVIVES the corresponding failure.
set -u
cd "$(dirname "$0")"

JAR=tla2tools.jar
CONFIGS=(
    MC_Base            # all assumptions in force: everything holds
    MC_Base_Tc3Te5     # same, different deadlines (robustness of the result)
    MC_NoMonitor       # ~A4: I2 refuted
    MC_NoMonitor_Rest  # ~A4: I1, I3a, I3b, I3c still hold exhaustively
    MC_Forge_I3a       # ~A6: class preservation refuted
    MC_Forge_I3b       # ~A6: amount preservation refuted
    MC_Forge_Rest      # ~A6: I1, I2, I3c and NoStuckEscrow still hold
    MC_NoA8_I3a        # ~A8: class preservation refuted with an HONEST relay
    MC_NoA8_Rest       # ~A8: everything else still holds
)

mkdir -p logs
for cfg in "${CONFIGS[@]}"; do
    echo "==== TLC: ${cfg}.cfg ===="
    java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC \
        -config "${cfg}.cfg" \
        -metadir "logs/metadir_${cfg}" \
        -workers 1 \
        HTLCCallback.tla | tee "logs/${cfg}.log"
    echo
done
echo "All runs finished. Logs are in ./logs/."
