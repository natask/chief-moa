#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

version="${MOA_MAC_VERSION:-$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' Resources/Info.plist)}"
build="${MOA_MAC_BUILD:-$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' Resources/Info.plist)}"

if [ "${#version}" -gt 64 ] || ! printf '%s\n' "$version" | grep -Eq '^[0-9]+(\.[0-9]+){0,2}$'; then
  echo "MOA_MAC_VERSION must be one to three dot-separated numeric components" >&2
  exit 2
fi
if [ "${#build}" -gt 64 ] || ! printf '%s\n' "$build" | grep -Eq '^[0-9]+(\.[0-9]+)*$'; then
  echo "MOA_MAC_BUILD must contain only dot-separated numeric components" >&2
  exit 2
fi

swift build -c release --product MoaMac
app="dist/MoaMac.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp ".build/release/MoaMac" "$app/Contents/MacOS/MoaMac"
chmod 755 "$app/Contents/MacOS/MoaMac"
cp "Resources/Info.plist" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $version" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build" "$app/Contents/Info.plist"
touch -t 202601010000 "$app/Contents/Info.plist" "$app/Contents/MacOS/MoaMac"
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
bash scripts/scan-moa-mac.sh "$app"

architectures="$(lipo -archs "$app/Contents/MacOS/MoaMac" | tr ' ' '-')"
archive="dist/MoaMac-${version}-${build}-${architectures}.zip"
checksum="$archive.sha256"
rm -f "$archive" "$checksum"
ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
digest="$(shasum -a 256 "$archive" | awk '{print $1}')"
printf '%s  %s\n' "$digest" "$(basename "$archive")" > "$checksum"

echo "Created ad-hoc signed QA bundle: $app"
echo "Created versioned QA archive: $archive"
echo "Created SHA-256 checksum: $checksum"
