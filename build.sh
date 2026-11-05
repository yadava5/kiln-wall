#!/usr/bin/env bash
# Builds build/KilnWall.app. `./build.sh install` also copies it to ~/Applications (without
# launching it). It seeds nothing in ~/.config/kiln-wall: the pages are the design folders in
# ~/.config/kiln-wall/designs/, and the stub page bundled here is the last fallback.
set -euo pipefail
cd "$(dirname "$0")"

app=build/KilnWall.app
# A clean bundle each time, so a page file deleted from page/ does not linger in Resources.
if [[ -e $app ]]; then /bin/rm -r "$app"; fi
/bin/mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
/bin/cp Info.plist "$app/Contents/Info.plist"
/bin/cp -R page "$app/Contents/Resources/page"
xcrun swiftc -O -swift-version 5 -target "$(/usr/bin/uname -m)-apple-macos14.0" \
  Sources/*.swift -o "$app/Contents/MacOS/KilnWall"
codesign --force --sign - "$app"
echo "built $app"

if [[ ${1:-} == install ]]; then
  /bin/mkdir -p ~/Applications
  if [[ -e ~/Applications/KilnWall.app ]]; then /bin/rm -r ~/Applications/KilnWall.app; fi
  ditto "$app" ~/Applications/KilnWall.app
  echo "installed ~/Applications/KilnWall.app"
  if /usr/bin/pgrep -x KilnWall >/dev/null; then
    echo "note: KilnWall is running the previous build; quit and reopen it to use this one"
  fi
fi
