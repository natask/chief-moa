#!/usr/bin/env bash
# Install unattended systemd timers on the VPS:
# - daily active-stack backup
# - weekly scratch restore check of the newest complete backup
#
# Dry-run is the default and prints the unit files. --install writes system
# units and enables the timers. It does not restart the active gateway.

set -euo pipefail

MODE="dry-run"
APP_DIR="${APP_DIR:-/opt/chief-moa/app}"
MOA_ROOT="${MOA_ROOT:-/opt/chief-moa}"
ENV_FILE="${ENV_FILE:-/opt/chief-moa/gateway.env}"
SYSTEMD_DIR="${MOA_SYSTEMD_DIR:-/etc/systemd/system}"
UNIT_PREFIX="${MOA_BACKUP_UNIT_PREFIX:-chief-moa}"
BACKUP_CALENDAR="${MOA_BACKUP_ON_CALENDAR:-*-*-* 03:15:00}"
RESTORE_CALENDAR="${MOA_RESTORE_ON_CALENDAR:-Sun *-*-* 04:15:00}"
BACKUP_DELAY="${MOA_BACKUP_RANDOMIZED_DELAY:-30m}"
RESTORE_DELAY="${MOA_RESTORE_RANDOMIZED_DELAY:-1h}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/vps/install-backup-timers.sh --dry-run
  sudo scripts/vps/install-backup-timers.sh --install

Options:
  --app-dir DIR              App checkout. Default: /opt/chief-moa/app.
  --moa-root DIR             State root. Default: /opt/chief-moa.
  --env-file FILE            Gateway env file. Default: /opt/chief-moa/gateway.env.
  --systemd-dir DIR          Unit directory. Default: /etc/systemd/system.
  --backup-calendar VALUE    systemd OnCalendar. Default: *-*-* 03:15:00.
  --restore-calendar VALUE   systemd OnCalendar. Default: Sun *-*-* 04:15:00.
  --dry-run                  Print units without writing. Default.
  --install                  Write units, daemon-reload, enable and start timers.

The timers run scripts/vps/backup.sh and scripts/vps/restore-latest-backup.sh.
They do not update, restart, or promote the active gateway.
USAGE
}

die() {
  printf '[vps-backup-timers] ERROR: %s\n' "$*" >&2
  exit 1
}

require_arg() {
  [ -n "${2:-}" ] || die "$1 requires a value"
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
    --app-dir)
      require_arg "$1" "${2:-}"
      APP_DIR="$2"
      shift 2
      ;;
    --moa-root)
      require_arg "$1" "${2:-}"
      MOA_ROOT="$2"
      shift 2
      ;;
    --env-file)
      require_arg "$1" "${2:-}"
      ENV_FILE="$2"
      shift 2
      ;;
    --systemd-dir)
      require_arg "$1" "${2:-}"
      SYSTEMD_DIR="$2"
      shift 2
      ;;
    --backup-calendar)
      require_arg "$1" "${2:-}"
      BACKUP_CALENDAR="$2"
      shift 2
      ;;
    --restore-calendar)
      require_arg "$1" "${2:-}"
      RESTORE_CALENDAR="$2"
      shift 2
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

backup_service="$UNIT_PREFIX-backup.service"
backup_timer="$UNIT_PREFIX-backup.timer"
restore_service="$UNIT_PREFIX-restore-check.service"
restore_timer="$UNIT_PREFIX-restore-check.timer"

render_backup_service() {
  cat <<EOF
[Unit]
Description=Chief Moa VPS backup
Wants=docker.service network-online.target
After=docker.service network-online.target

[Service]
Type=oneshot
Environment=MOA_ROOT=$MOA_ROOT
Environment=APP_DIR=$APP_DIR
Environment=ENV_FILE=$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/scripts/vps/backup.sh
TimeoutStartSec=1h
EOF
}

render_backup_timer() {
  cat <<EOF
[Unit]
Description=Run Chief Moa VPS backup on a schedule

[Timer]
OnCalendar=$BACKUP_CALENDAR
RandomizedDelaySec=$BACKUP_DELAY
Persistent=true
Unit=$backup_service

[Install]
WantedBy=timers.target
EOF
}

render_restore_service() {
  cat <<EOF
[Unit]
Description=Chief Moa VPS restore check of latest backup
Wants=docker.service network-online.target
After=docker.service network-online.target

[Service]
Type=oneshot
Environment=MOA_ROOT=$MOA_ROOT
Environment=APP_DIR=$APP_DIR
Environment=ENV_FILE=$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/scripts/vps/restore-latest-backup.sh
TimeoutStartSec=2h
EOF
}

render_restore_timer() {
  cat <<EOF
[Unit]
Description=Run Chief Moa VPS scratch restore check on a schedule

[Timer]
OnCalendar=$RESTORE_CALENDAR
RandomizedDelaySec=$RESTORE_DELAY
Persistent=true
Unit=$restore_service

[Install]
WantedBy=timers.target
EOF
}

print_units() {
  printf '%s\n' "### $SYSTEMD_DIR/$backup_service"
  render_backup_service
  printf '\n%s\n' "### $SYSTEMD_DIR/$backup_timer"
  render_backup_timer
  printf '\n%s\n' "### $SYSTEMD_DIR/$restore_service"
  render_restore_service
  printf '\n%s\n' "### $SYSTEMD_DIR/$restore_timer"
  render_restore_timer
}

write_unit() {
  local path="$1"
  local renderer="$2"
  local tmp
  tmp="$path.tmp.$$"
  "$renderer" > "$tmp"
  chmod 0644 "$tmp"
  mv "$tmp" "$path"
}

printf '[vps-backup-timers] mode: %s\n' "$MODE" >&2
printf '[vps-backup-timers] backup calendar: %s\n' "$BACKUP_CALENDAR" >&2
printf '[vps-backup-timers] restore calendar: %s\n' "$RESTORE_CALENDAR" >&2

if [ "$MODE" != "install" ]; then
  print_units
  exit 0
fi

[ "$(id -u)" -eq 0 ] || die "--install must run as root"
[ -x "$APP_DIR/scripts/vps/backup.sh" ] || die "missing executable backup script at $APP_DIR/scripts/vps/backup.sh"
[ -x "$APP_DIR/scripts/vps/restore-latest-backup.sh" ] || die "missing executable restore script at $APP_DIR/scripts/vps/restore-latest-backup.sh"
mkdir -p "$SYSTEMD_DIR"

write_unit "$SYSTEMD_DIR/$backup_service" render_backup_service
write_unit "$SYSTEMD_DIR/$backup_timer" render_backup_timer
write_unit "$SYSTEMD_DIR/$restore_service" render_restore_service
write_unit "$SYSTEMD_DIR/$restore_timer" render_restore_timer

systemctl daemon-reload
systemctl enable --now "$backup_timer" "$restore_timer"

systemctl list-timers "$backup_timer" "$restore_timer" --no-pager
printf '[vps-backup-timers] installed and enabled\n' >&2
