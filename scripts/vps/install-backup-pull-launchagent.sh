#!/usr/bin/env bash
# Install a macOS LaunchAgent that pulls completed VPS backup directories to
# this operator machine. Dry-run is the default and prints the plist.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="dry-run"
HOST="${MOA_VPS_BACKUP_HOST:-}"
REMOTE_DIR="${MOA_VPS_BACKUP_REMOTE_DIR:-/opt/chief-moa/backups}"
DEST_DIR="${MOA_VPS_BACKUP_DEST_DIR:-}"
LABEL="${MOA_VPS_BACKUP_LAUNCHAGENT_LABEL:-ai.moa.vps-backup-pull}"
HOUR="${MOA_VPS_BACKUP_PULL_HOUR:-4}"
MINUTE="${MOA_VPS_BACKUP_PULL_MINUTE:-45}"
PLIST_DIR="${MOA_VPS_BACKUP_LAUNCHAGENT_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${MOA_VPS_BACKUP_LOG_DIR:-$HOME/Library/Logs}"
LOAD_AGENT=1

usage() {
  cat <<'USAGE'
Usage:
  scripts/vps/install-backup-pull-launchagent.sh --dry-run --host root@vps --dest ~/Backups/chief-moa-vps
  scripts/vps/install-backup-pull-launchagent.sh --install --host root@vps --dest ~/Backups/chief-moa-vps

Options:
  --host USER@HOST       VPS SSH target. Required.
  --remote-dir DIR       Remote backup directory. Default: /opt/chief-moa/backups.
  --dest DIR             Local backup mirror destination. Required.
  --hour N               Local hour for StartCalendarInterval. Default: 4.
  --minute N             Local minute for StartCalendarInterval. Default: 45.
  --label LABEL          LaunchAgent label. Default: ai.moa.vps-backup-pull.
  --dry-run              Print plist without writing. Default.
  --install              Write plist and load it with launchctl.
  --no-load              With --install, write the plist but do not load it.

The LaunchAgent runs scripts/vps/pull-backups.sh --execute. It never restarts
or promotes the gateway.
USAGE
}

die() {
  printf '[vps-backup-launchagent] ERROR: %s\n' "$*" >&2
  exit 1
}

require_arg() {
  [ -n "${2:-}" ] || die "$1 requires a value"
}

is_int() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

xml_escape() {
  printf '%s' "$1" |
    sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      MODE="dry-run"
      shift
      ;;
    --install)
      MODE="install"
      shift
      ;;
    --host)
      require_arg "$1" "${2:-}"
      HOST="$2"
      shift 2
      ;;
    --remote-dir)
      require_arg "$1" "${2:-}"
      REMOTE_DIR="$2"
      shift 2
      ;;
    --dest)
      require_arg "$1" "${2:-}"
      DEST_DIR="$2"
      shift 2
      ;;
    --hour)
      require_arg "$1" "${2:-}"
      HOUR="$2"
      shift 2
      ;;
    --minute)
      require_arg "$1" "${2:-}"
      MINUTE="$2"
      shift 2
      ;;
    --label)
      require_arg "$1" "${2:-}"
      LABEL="$2"
      shift 2
      ;;
    --no-load)
      LOAD_AGENT=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "$HOST" ] || die "--host or MOA_VPS_BACKUP_HOST is required"
[ -n "$DEST_DIR" ] || die "--dest or MOA_VPS_BACKUP_DEST_DIR is required"
is_int "$HOUR" || die "--hour must be an integer"
is_int "$MINUTE" || die "--minute must be an integer"
[ "$HOUR" -ge 0 ] && [ "$HOUR" -le 23 ] || die "--hour must be 0..23"
[ "$MINUTE" -ge 0 ] && [ "$MINUTE" -le 59 ] || die "--minute must be 0..59"

plist_path="$PLIST_DIR/$LABEL.plist"
out_log="$LOG_DIR/$LABEL.out.log"
err_log="$LOG_DIR/$LABEL.err.log"

pull_command() {
  printf 'cd %q && scripts/vps/pull-backups.sh --execute --host %q --remote-dir %q --dest %q' \
    "$ROOT_DIR" "$HOST" "$REMOTE_DIR" "$DEST_DIR"
}

render_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>$(xml_escape "$(pull_command)")</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>$HOUR</integer>
    <key>Minute</key>
    <integer>$MINUTE</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$out_log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$err_log")</string>
</dict>
</plist>
EOF
}

printf '[vps-backup-launchagent] mode: %s\n' "$MODE" >&2
printf '[vps-backup-launchagent] plist: %s\n' "$plist_path" >&2
printf '[vps-backup-launchagent] source: %s:%s\n' "$HOST" "$REMOTE_DIR" >&2
printf '[vps-backup-launchagent] destination: %s\n' "$DEST_DIR" >&2

if [ "$MODE" != "install" ]; then
  render_plist
  exit 0
fi

mkdir -p "$PLIST_DIR" "$LOG_DIR" "$DEST_DIR"
tmp="$plist_path.tmp.$$"
render_plist > "$tmp"
plutil -lint "$tmp" >/dev/null
mv "$tmp" "$plist_path"

if [ "$LOAD_AGENT" = "1" ]; then
  launchctl bootout "gui/$(id -u)" "$plist_path" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist_path"
  launchctl enable "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
fi

printf '[vps-backup-launchagent] installed: %s\n' "$plist_path" >&2
