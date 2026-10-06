#!/bin/bash
# Cargo runner for macOS dev builds: signs the freshly built binary with the
# "VideoVault Dev" certificate (if it exists in your keychain), then runs it.
#
# Why: macOS remembers a Keychain "Always Allow" per app signature. Unsigned
# dev builds get a new signature on every rebuild, so the Mage API key prompt
# came back each time. Signed with one stable certificate, the app keeps the
# same identity, and the first "Always Allow" sticks.
#
# Without the certificate this just runs the binary as before.

BIN="$1"
IDENTITY="VideoVault Dev"

if [ -f "$BIN" ] && security find-certificate -c "$IDENTITY" >/dev/null 2>&1; then
  if ! codesign --force --sign "$IDENTITY" --identifier com.videovault.app "$BIN" 2>/tmp/videovault-codesign.log; then
    echo "dev-sign-run: could not sign with \"$IDENTITY\" (see /tmp/videovault-codesign.log); running unsigned" >&2
  fi
fi

exec "$@"
