#!/usr/bin/env bash
# install-agent.sh: run the shared feed, `kiln-feed.py --serve`, as a per-user LaunchAgent.
#
#   scripts/install-agent.sh              install (or update) it, and start it
#   scripts/install-agent.sh --uninstall  stop it and remove it
#
# Optional. Without it KilnWall runs its own kiln-feed.py child, as it always has. With it,
# KilnWall and anything else that reads the feed subscribe to one always-on process on
# ~/Library/Application Support/kiln-feed/feed.sock: they see the same session state at the
# same instant, a session change reaches them in milliseconds instead of at the next period,
# and the feed's work is done once. An app that starts before the agent, or finds it gone,
# falls back to its own child and moves to the agent within 30 s of it answering.
#
# The feed it runs is the one KilnWall runs: $KILN_FEED_SCRIPT, else the first that exists of
# ~/.config/kiln-wall/feed/kiln-feed.py (scripts/install.sh puts it there) and
# ~/.config/kitty/kiln-feed.py. The plist is written with your paths when you run this; this
# script itself names nobody's. ProcessType Interactive by default: on the performance cores
# it takes about half the CPU-seconds it takes at Background (docs/shared-feed.md). Set
# KILN_FEED_PROCESS_TYPE=Background to trade CPU-seconds for energy on a Mac that lives on
# battery. Restarted if it exits (KeepAlive), and it logs nothing to disk.
# `python3 <feed> --status` lists its subscribers.
set -euo pipefail
cd "$(dirname "$0")/.."

label="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' Info.plist).feed"
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(/usr/bin/id -u)"

if [[ ${1:-} == --uninstall ]]; then
  /bin/launchctl bootout "$domain/$label" 2>/dev/null || true
  if [[ -e $plist ]]; then /bin/rm "$plist"; fi
  echo "removed $label (the feed removes its socket as it stops)"
  exit 0
fi

if [[ -n ${KILN_FEED_SCRIPT:-} ]]; then
  feed=${KILN_FEED_SCRIPT/#\~/$HOME}
else
  feed=
  for p in "$HOME/.config/kiln-wall/feed/kiln-feed.py" "$HOME/.config/kitty/kiln-feed.py"; do
    if [[ -e $p ]]; then feed=$p; break; fi
  done
fi
if [[ -z $feed || ! -e $feed ]]; then
  echo "install-agent: no kiln-feed.py found; run scripts/install.sh first (or set KILN_FEED_SCRIPT)" >&2
  exit 1
fi
if ! /usr/bin/grep -q -- '--serve' "$feed"; then
  echo "install-agent: $feed has no --serve (an older copy); take the newer feed/ first" >&2
  exit 1
fi
case $feed in *'&'* | *'<'* | *'>'*)
  echo "install-agent: a path with & < or > is not written into a plist: $feed" >&2
  exit 1 ;;
esac

# Loaded as a module, not run as the script: Python compiles the script it runs on every start
# and never caches that, and the compiler's ~10 MB stays with the process (measured 2026-11-27:
# 28.8 MB RSS run as the script, 18.4 MB loaded as a module from its cached bytecode).
process_type="${KILN_FEED_PROCESS_TYPE:-Interactive}"
case $process_type in Interactive|Standard|Adaptive|Background) ;; *)
  echo "install-agent: KILN_FEED_PROCESS_TYPE must be Interactive, Standard, Adaptive or Background" >&2
  exit 2
esac
loader='import importlib.util as u, sys; s = u.spec_from_file_location("kiln_feed", sys.argv[1]); m = u.module_from_spec(s); s.loader.exec_module(m); sys.argv = sys.argv[1:]; m.main()'

/bin/mkdir -p "$HOME/Library/LaunchAgents"
/bin/cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>-c</string>
    <string>$loader</string>
    <string>$feed</string>
    <string>--serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>$process_type</string>
</dict>
</plist>
EOF
/usr/bin/plutil -lint "$plist" >/dev/null

/bin/launchctl bootout "$domain/$label" 2>/dev/null || true
# bootout returns before the job is gone; a bootstrap that lands first fails with error 5.
for _ in $(/usr/bin/seq 50); do
  /bin/launchctl print "$domain/$label" >/dev/null 2>&1 || break
  /bin/sleep 0.1
done
/bin/launchctl bootstrap "$domain" "$plist"
sock="$HOME/Library/Application Support/kiln-feed/feed.sock"
for _ in $(/usr/bin/seq 50); do [[ -S $sock ]] && break; /bin/sleep 0.1; done
if [[ -S $sock ]]; then
  echo "installed $label: $feed --serve, on $sock"
else
  echo "install-agent: $label is loaded but no socket appeared within 5 s; see: launchctl print $domain/$label" >&2
  exit 1
fi
