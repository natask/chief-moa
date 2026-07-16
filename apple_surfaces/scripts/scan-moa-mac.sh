#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
app="${1:-dist/MoaMac.app}"
binary="$app/Contents/MacOS/MoaMac"

if [ ! -x "$binary" ]; then
  echo "MoaMac binary not found: $binary" >&2
  exit 2
fi

pattern='api\.agee\.app|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|posthog|sentry|Sparkle\.framework|SPUStandardUpdaterController|SUFeedURL|SkyLight|SLSPost|SLPS'
if rg -n -i "$pattern" Sources/MoaMac Sources/MoaMacCore Sources/MoaMacShell Sources/MoaMacUI Resources; then
  echo "Prohibited packaged destination, telemetry, updater, or private API reference found in MoaMac sources." >&2
  exit 1
fi
if strings "$binary" | rg -n -i "$pattern"; then
  echo "Prohibited packaged destination, telemetry, updater, or private API reference found in MoaMac binary." >&2
  exit 1
fi

echo "MoaMac source and binary scan passed"
