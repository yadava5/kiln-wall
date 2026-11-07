#!/bin/bash
# batch.sh <spec-file>: one measure per line "tag dir design period [MEAS] [SAMP,SAMP]", run in order
# through m.sh. Measure a candidate and glass back to back in one batch: absolute numbers drift.
D=$(cd "$(dirname "$0")" && pwd)
while read -r tag dir design period meas samp; do
  [ -z "$tag" ] && continue
  case "$tag" in \#*) continue;; esac
  if [ -n "$meas" ]; then
    KILN_DESIGNS_DIR=$dir MEAS=$meas SAMP="${samp//,/ }" $D/m.sh $tag $design $period
  else
    KILN_DESIGNS_DIR=$dir $D/m.sh $tag $design $period
  fi
  /bin/sleep 5
done < "$1"
echo BATCH_DONE "$1"
