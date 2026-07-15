#!/bin/bash
# Build the native SwiftUI Backfill.app (replaces the old zsh launcher binary).
# Pattern: window-arranger-oracle scripts/build-app.sh — plain swiftc + ad-hoc codesign.
set -euo pipefail

ROOT="/opt/Code/github.com/Soul-Brews-Studio/atlas-discord-backfill-oracle"
SRC="$ROOT/app/native"
APP="$ROOT/app/Backfill.app"
BIN="$APP/Contents/MacOS/backfill"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "── swiftc ──"
swiftc -O -parse-as-library -o "$BIN" "$SRC"/*.swift

echo "── Info.plist ──"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Backfill</string>
  <key>CFBundleDisplayName</key><string>Backfill</string>
  <key>CFBundleIdentifier</key><string>studio.soulbrews.backfill</string>
  <key>CFBundleVersion</key><string>2.0.0</string>
  <key>CFBundleShortVersionString</key><string>2.0.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>backfill</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><false/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

echo "── codesign (ad-hoc) ──"
codesign --force --sign - "$APP"

echo "── result ──"
file "$BIN"
ls -lh "$BIN" | awk '{print $5, $9}'
