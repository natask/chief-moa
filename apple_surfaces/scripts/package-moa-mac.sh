#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
swift build -c release --product MoaMac
app="dist/MoaMac.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp ".build/release/MoaMac" "$app/Contents/MacOS/MoaMac"
chmod 755 "$app/Contents/MacOS/MoaMac"
cp "Resources/Info.plist" "$app/Contents/Info.plist"
touch -t 202601010000 "$app/Contents/Info.plist" "$app/Contents/MacOS/MoaMac"
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
echo "Created ad-hoc signed QA bundle: $app"
