#!/bin/bash
# m.sh <tag> <design> <period> [extra KilnWall args...]   (env KILN_DESIGNS_DIR passes through)
# One KilnWall --measure run: waits for a quiet machine (load1 < 3), takes measure.lock with mkdir
# (released in a trap), waits out any other --measure run, samples the WebContent and GPU footprint
# at SAMP seconds (default 25 35). Output: runs/<tag>.log. MEAS = seconds (default 40).
D=$(cd "$(dirname "$0")" && pwd)
# Logs and the lock live OUTSIDE designs/: KilnWall reloads the live wallpaper on any change there.
R=${KILN_RUNS:-$HOME/.cache/kiln-wall}; /bin/mkdir -p $R/runs
LOCK=$R/measure.lock
tag=$1; d=$2; p=$3; shift 3
out=$R/runs/$tag.log
for i in $(seq 1 60); do
  l1=$(/usr/sbin/sysctl -n vm.loadavg | /usr/bin/awk '{print $2}')
  /usr/bin/awk -v l=$l1 'BEGIN{exit !(l<3)}' && break
  /bin/sleep 10
done
while ! /bin/mkdir $LOCK 2>/dev/null; do /bin/sleep 3; done
trap '/bin/rmdir $LOCK 2>/dev/null' EXIT INT TERM
# The installed app: $KILNWALL_APP, else ~/Applications/KilnWall.app (./build.sh install puts it there).
K=${KILNWALL_APP:-$HOME/Applications/KilnWall.app}/Contents/MacOS/KilnWall
while /usr/bin/pgrep -f "^$K --measure" >/dev/null; do /bin/sleep 3; done
{ echo "tag=$tag design=$d period=$p args=$* dir=${KILN_DESIGNS_DIR:-live}"; echo "load_before: $(/usr/sbin/sysctl -n vm.loadavg)"; } > $out
"$K" --measure ${MEAS:-40} --design $d --period-ms $p "$@" >> $out 2>&1 &
kp=$!
prev=0
for t in ${SAMP:-25 35}; do
  /bin/sleep $((t-prev)); prev=$t
  wc=$(/usr/bin/grep -o 'WebContent pid [0-9]*' $out | /usr/bin/tail -1 | /usr/bin/awk '{print $3}')
  echo "--- fp@$t s (wc=$wc)" >> $out
  gpu=$(/usr/bin/pgrep -n -f 'com.apple.WebKit.GPU')
  [ -n "$wc" ] && echo "WC $wc $($D/fp.sh $wc)" >> $out
  [ -n "$gpu" ] && echo "GPU $gpu $($D/fp.sh $gpu)" >> $out
done
wait $kp
echo "exit=$? load_after: $(/usr/sbin/sysctl -n vm.loadavg)" >> $out
