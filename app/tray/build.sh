#!/bin/zsh
# Build "Backfill Tray.app" — NSStatusItem menu-bar glance (cookbook technique).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/Backfill Tray.app"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Backfill Tray</string>
  <key>CFBundleIdentifier</key><string>studio.soulbrews.backfill-tray</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>backfill-tray</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

swiftc -O "$HERE/main.swift" -o "$APP/Contents/MacOS/backfill-tray"
codesign --force --sign - "$APP" 2>/dev/null || true
file "$APP/Contents/MacOS/backfill-tray"
ls -lh "$APP/Contents/MacOS/backfill-tray" | awk '{print $5}'
