#!/bin/sh
# usage: dev-shot.sh <design dir> <out.png> [query] [virtual ms]
# A 1512x982 @2x screenshot of a design in headless Chromium, fed by the fixture replay.
# Default query "?fixture&still=8": replay 8 lines, then hold still for the shot.
# Add &home for the real Dock and notch. This is a still of a live page; the real
# check is KilnWall --snapshot with the live feed.
# The virtual-time budget must cover still x period plus load: 15 s reaches
# still=40 at 250 ms. Headless frames are sparse, so the runtime lands every
# tween when the replay stops.
#
# chrome-headless-shell, never "/Applications/Google Chrome.app": every launch of the
# app bundle, headless or not, flashes a tile into the Dock (recorded 2026-11-05: six
# parallel renders put six Chrome tiles in the Dock for ~0.7 s, in plain view). The
# shell is a bare binary with no bundle, so the Dock never hears of it.
# Launched through chrome-bg.sh: at most two renders at once across every agent, at
# background QoS on the efficiency cores (2026-11-05: parallel renders pinned all
# ten cores while the machine was in use).
CH="$(dirname "$0")/chrome-bg.sh"
D="$1"; OUT="$2"; Q="${3:-?fixture&still=8}"; V="${4:-15000}"
UD=$(/usr/bin/mktemp -d /tmp/kiln-dev.XXXX)
"$CH" --disable-gpu --hide-scrollbars \
  --user-data-dir="$UD" --allow-file-access-from-files --virtual-time-budget="$V" \
  --force-device-scale-factor=2 --window-size=1512,982 --screenshot="$OUT" "file://$D/index.html$Q" >/dev/null 2>&1
/bin/rm -r "$UD"
/usr/bin/sips -g pixelWidth -g pixelHeight "$OUT" | /usr/bin/tail -2
