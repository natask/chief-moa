#!/usr/bin/env bash
# Build the Android OTA artifact and publish it to the VPS gateway
# (api.agee.app), which serves it from /data/android-ota inside the gateway
# container. Replaces sync-main-machine.sh now that the main machine is
# decommissioned.
#
#   MOA_VPS_SSH=root@vps android_app/deploy/ota/sync-vps.sh
#   android_app/deploy/ota/sync-vps.sh --host root@vps
#
# The host is never guessed. It must come from --host or MOA_VPS_SSH.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LOCAL_OTA_DIR="${ANDROID_OTA_OUT_DIR:-$ROOT_DIR/gateway/data/android-ota}"
HOST="${MOA_VPS_SSH:-}"
# Host-side path of the gateway container's /data named volume.
REMOTE_OTA_DIR="${MOA_VPS_OTA_DIR:-/var/lib/docker/volumes/chief-moa_moa-gateway-data/_data/android-ota}"

while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      if [ -z "${2:-}" ]; then
        echo "--host requires user@host" >&2
        exit 1
      fi
      HOST="$2"
      shift 2
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$HOST" ]; then
  echo "No VPS host. Pass --host user@vps or set MOA_VPS_SSH." >&2
  exit 1
fi

# build-ota-artifact.sh publishes into the versioned layout:
#   releases/<release_id>/{moa-assistant.apk,release.json}
#   current -> releases/<release_id>        (atomic, relative symlink)
#   moa-assistant.apk + latest.json         (legacy, for pre-rollback clients)
"$ROOT_DIR/android_app/deploy/ota/build-ota-artifact.sh"

ssh -o ConnectTimeout=10 "$HOST" "mkdir -p '$REMOTE_OTA_DIR'"
# -a preserves the relative `current` symlink as a symlink; --delete prunes
# stale releases so the remote store matches the local one.
rsync -az --delete "$LOCAL_OTA_DIR/" "$HOST:$REMOTE_OTA_DIR/"

echo "Synced Android OTA releases + current pointer to $HOST:$REMOTE_OTA_DIR"
