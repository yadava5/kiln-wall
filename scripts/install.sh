#!/usr/bin/env bash
# install.sh: build KilnWall and put its three parts where it looks for them.
#
#   scripts/install.sh            build, then install anything not already installed
#
#   ~/Applications/KilnWall.app        the app             (replaced: it is a build product)
#   ~/.config/kiln-wall/designs/       the designs         (copied once; never overwritten)
#   ~/.config/kiln-wall/feed/          the data feed       (copied once; never overwritten)
#
# The designs and the feed are yours to edit after the first install, so this script never
# touches an existing copy. To take a newer version, move yours aside and run it again.
# It does not launch the app.
set -euo pipefail
cd "$(dirname "$0")/.."

./build.sh install

cfg="$HOME/.config/kiln-wall"
mkdir -p "$cfg"
for part in designs feed; do
  if [[ -e "$cfg/$part" ]]; then
    echo "kept $cfg/$part (already there; not overwritten)"
  else
    cp -R "$part" "$cfg/$part"
    echo "installed $cfg/$part"
  fi
done

cat <<'EOF'

Next:
  1. Open ~/Applications/KilnWall.app. It lives in the menu bar; the panel there picks a design.
  2. Optional: weather. Set KILN_LAT and KILN_LON for the feed (see feed/kiln-feed.py's header).
  3. Optional: GitHub. The feed uses `gh auth token`, or GH_TOKEN.
EOF
