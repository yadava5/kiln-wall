#!/bin/bash
# chrome-bg.sh: chrome-headless-shell for dev renders, AT MOST TWO AT ONCE, at background QoS.
#
#   chrome-bg.sh <chrome-headless-shell args...>
#
# Use this in place of chrome-headless-shell everywhere: dev-shot.sh, dev-dom.sh and
# dev-audit.mjs launch through it, and any ad-hoc Playwright script should pass it as
# `executablePath`. Why (2026-11-05): five parallel design renders took all ten cores
# to 100% and load average hit 13 on a 10-core Mac that was in use.
#
# 1. At most two at once: machine-wide slots /tmp/kiln-chrome.lock.{1,2}. A
#    render waits for a free slot; a stale slot (its pid dead) is taken over.
# 2. Background QoS (`taskpolicy -c background`): macOS keeps it on the efficiency
#    cores at the lowest priority, so the apps in use always win. Renders are slower; that
#    is the point. Elsewhere (Linux CI) it runs under `nice -n 19` instead.
#
# The browser: $KILN_CHROME if set, else the newest chrome-headless-shell that
# `npx playwright-core install chromium-headless-shell` put in Playwright's cache.
CH=${KILN_CHROME:-$(/bin/ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-*/chrome-headless-shell \
  "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell 2>/dev/null | tail -1)}
[ -x "$CH" ] || { echo "chrome-bg: no chrome-headless-shell (set KILN_CHROME, or run: npx playwright-core install chromium-headless-shell)" >&2; exit 1; }
# Two slots: never more than half of the Mac's CPU. Background QoS keeps both on the efficiency cores, so two renders
# together stay well under half of the ten cores.
L=
while [ -z "$L" ]; do
  for s in 1 2; do
    c=/tmp/kiln-chrome.lock.$s   # /tmp is /private/tmp on macOS: the same slots as before
    if /bin/mkdir "$c" 2>/dev/null; then L=$c; break; fi
    p=$(/bin/cat "$c/pid" 2>/dev/null)
    if [ -n "$p" ] && ! /bin/kill -0 "$p" 2>/dev/null; then
      /bin/rm -f "$c/pid"; /bin/rmdir "$c" 2>/dev/null
    fi
  done
  [ -n "$L" ] || /bin/sleep 0.5
done
echo $$ > "$L/pid"
release() { /bin/rm -f "$L/pid"; /bin/rmdir "$L" 2>/dev/null; }
trap release EXIT
trap 'kill -TERM "$child" 2>/dev/null; exit 143' TERM INT HUP
if [ -x /usr/sbin/taskpolicy ]; then /usr/sbin/taskpolicy -c background "$CH" "$@" &
else nice -n 19 "$CH" "$@" &
fi
child=$!
wait "$child"
