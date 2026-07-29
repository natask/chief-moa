#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
app="${1:-dist/Ag.app}"
binary="$app/Contents/MacOS/Ag"

if [ ! -x "$binary" ]; then
  echo "Ag binary not found: $binary" >&2
  exit 2
fi

prohibited_pattern='posthog|sentry|Sparkle\.framework|SPUStandardUpdaterController|SUFeedURL|SkyLight|SLSPost|SLPS'
destination_pattern='https?://[[:alnum:]]'
credential_pattern='sk-(proj-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|phc_[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.'
persistence_pattern="Keychain""Token|app"'\.agee\.moa-mac\.gateway|generic'"-password"
if rg -n -i "$persistence_pattern" Sources Resources; then
  echo "Credential persistence API or identifier found in Apple runnable sources/configuration." >&2
  exit 1
fi
if rg -n -i "$prohibited_pattern|$credential_pattern" Sources/Ag Sources/MoaMacCore Sources/MoaMacShell Sources/MoaMacUI Resources; then
  echo "Prohibited packaged destination, telemetry, updater, or private API reference found in Ag sources." >&2
  exit 1
fi
if rg -n -i "$destination_pattern" Sources/Ag Sources/MoaMacCore Sources/MoaMacShell Sources/MoaMacUI | rg -v 'https://api\.agee\.app'; then
  echo "Packaged network destination found in Ag sources." >&2
  exit 1
fi
if strings "$binary" | rg -n -i "$prohibited_pattern|$destination_pattern|$credential_pattern" | rg -v 'https://api\.agee\.app'; then
  echo "Prohibited packaged destination, telemetry, updater, or private API reference found in Ag binary." >&2
  exit 1
fi
if strings "$binary" | rg -n -i "$persistence_pattern"; then
  echo "Credential persistence API or identifier found in Ag binary." >&2
  exit 1
fi

echo "Ag source and binary scan passed"
