#!/bin/bash
# fp.sh <pid> -> "fp=N MB | graphics lines"
/usr/bin/footprint $1 2>/dev/null | /usr/bin/awk '/Footprint:/{sub(/.*Footprint: /,"");f=$0} /graphics/{g=g" | "$1" "$2" "$NF" "$(NF-1)} END{print "fp=" f g}'
