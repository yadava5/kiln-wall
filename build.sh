#!/usr/bin/env bash
# Builds build/KilnWall.app. `./build.sh install` also copies it to ~/Applications (without
# launching it) and seeds ~/.config/kiln-wall/page/ with the stub page if that folder is missing.
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
  if [[ ! -d ~/.config/kiln-wall/page ]]; then
    /bin/mkdir -p ~/.config/kiln-wall
    /bin/cp -R page ~/.config/kiln-wall/page
    echo "seeded ~/.config/kiln-wall/page with the stub page"
  fi
  if /usr/bin/pgrep -x KilnWall >/dev/null; then
    echo "note: KilnWall is running the previous build; quit and reopen it to use this one"
  fi
fi
