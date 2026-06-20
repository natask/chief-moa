#!/usr/bin/env bash
set -euo pipefail

REMOTE="${REMOTE:-reclaim@10.147.17.10}"
REMOTE_OTA_DIR="${REMOTE_OTA_DIR:-/home/reclaim-ethiopia/moa-assistant-data/moa_gateway/android-ota}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LOCAL_OTA_DIR="${ANDROID_OTA_OUT_DIR:-$ROOT_DIR/gateway/data/android-ota}"

"$ROOT_DIR/android_app/deploy/ota/build-ota-artifact.sh"

ssh -o ConnectTimeout=10 "$REMOTE" "mkdir -p '$REMOTE_OTA_DIR'"
rsync -az --delete "$LOCAL_OTA_DIR/" "$REMOTE:$REMOTE_OTA_DIR/"

echo "Synced Android OTA artifact to $REMOTE:$REMOTE_OTA_DIR"
