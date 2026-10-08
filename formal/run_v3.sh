#!/usr/bin/env bash
# Run the TLC configurations of HTLCCallback_v3.tla (secret modelled as an
# event of its own; NoLoss; assumption A9 = TIMELY). See results_v3.md.
set -u
cd "$(dirname "$0")"
JAR=tla2tools.jar
CONFIGS=(MC3_Base MC3_Base_Tc3Te5 MC3_NoMonitor MC3_NoMonitor_Rest MC3_Forge_I3a MC3_Forge_I3b
         MC3_Forge_Rest MC3_NoA8_I3a MC3_NoA8_Rest MC3_NoA9 MC3_NoA9_Late MC3_NoA9_Rest
         MC3_Live MC3_Live_NoA4)
mkdir -p logs_v3
for cfg in "${CONFIGS[@]}"; do
    echo "==== TLC: ${cfg}.cfg ===="
    java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -config "${cfg}.cfg" \
        -metadir "logs_v3/metadir_${cfg}" -workers 1 HTLCCallback_v3.tla | tee "logs_v3/${cfg}.log"
done
