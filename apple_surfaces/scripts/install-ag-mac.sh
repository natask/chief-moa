#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

source_app="${1:-dist/Ag.app}"
install_dir="${AG_MAC_INSTALL_DIR:-/Applications}"
target="$install_dir/Ag.app"

if [ ! -d "$source_app" ] || [ ! -x "$source_app/Contents/MacOS/Ag" ]; then
  echo "Packaged Ag.app not found: $source_app" >&2
  exit 2
fi
if [ -e "$target" ]; then
  echo "Refusing to replace an existing app without an explicit update/rollback transaction: $target" >&2
  exit 3
fi
if [ ! -d "$install_dir" ] || [ ! -w "$install_dir" ]; then
  echo "Install directory is not writable: $install_dir" >&2
  exit 4
fi

codesign --verify --deep --strict "$source_app"
bundle_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$source_app/Contents/Info.plist")"
executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$source_app/Contents/Info.plist")"
if [ "$bundle_name" != "Ag" ] || [ "$executable" != "Ag" ]; then
  echo "Package identity is not Ag.app" >&2
  exit 5
fi

staging="$(mktemp -d "$install_dir/.ag-install.XXXXXX")"
trap 'rm -rf "$staging"' EXIT HUP INT TERM
ditto "$source_app" "$staging/Ag.app"
mv "$staging/Ag.app" "$target"
codesign --verify --deep --strict "$target"
echo "Installed Ag.app: $target"
