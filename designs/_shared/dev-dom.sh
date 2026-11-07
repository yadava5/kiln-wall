#!/bin/sh
# usage: dev-dom.sh <design dir> [query] [virtual ms]
# Dumps the rendered DOM of a design in headless Chromium (fixture replay), for checks.
# chrome-headless-shell, not the Chrome app bundle: the bundle flashes a Dock tile on
# every launch (see dev-shot.sh).
# Launched through chrome-bg.sh: at most two renders at once, background QoS (see there).
CH="$(dirname "$0")/chrome-bg.sh"
D="$1"; Q="${2:-?fixture}"; V="${3:-3000}"
UD=$(/usr/bin/mktemp -d /tmp/kiln-dev.XXXX)
"$CH" --disable-gpu \
  --user-data-dir="$UD" --allow-file-access-from-files --virtual-time-budget="$V" --window-size=1512,982 \
  --dump-dom "file://$D/index.html$Q" 2>/dev/null
/bin/rm -r "$UD"
