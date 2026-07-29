#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
output_dir="${1:-$repo_dir/reference/openspec/changes/overlay-companion-ribbons/evidence/android-visual-qa}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

mkdir -p "$output_dir"
cd "$repo_dir/android_app"
./gradlew testDebugUnitTest \
  --tests ag.companion.MoaOverlayVisualCaptureTest \
  -PmoaVisualOutput="$output_dir"

echo "Android render evidence: $output_dir"
