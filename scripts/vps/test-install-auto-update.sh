#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

SYSTEMD_DIR="$TEST_ROOT/systemd"
SYSTEMCTL_LOG="$TEST_ROOT/systemctl.log"
mkdir -p "$SYSTEMD_DIR/chief-moa-auto-update.timer.d" "$TEST_ROOT/bin"
printf '[Timer]\nOnUnitActiveSec=1800\n' \
  >"$SYSTEMD_DIR/chief-moa-auto-update.timer.d/interval.conf"
cat >"$TEST_ROOT/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$TEST_SYSTEMCTL_LOG"
EOF
chmod +x "$TEST_ROOT/bin/systemctl"

PATH="$TEST_ROOT/bin:$PATH" TEST_SYSTEMCTL_LOG="$SYSTEMCTL_LOG" \
  MOA_SYSTEMD_DIR="$SYSTEMD_DIR" MOA_VPS_APP_DIR="/srv/chief-moa/app" \
  bash "$SCRIPT_DIR/install-auto-update.sh" >/dev/null

service="$SYSTEMD_DIR/chief-moa-auto-update.service"
timer="$SYSTEMD_DIR/chief-moa-auto-update.timer"
grep -qx 'Type=oneshot' "$service"
grep -qx 'Environment=MOA_VPS_APP_DIR=/srv/chief-moa/app' "$service"
grep -qx 'ExecStart=/usr/bin/bash /srv/chief-moa/app/scripts/vps/auto-update.sh' "$service"
grep -qx 'OnBootSec=90' "$timer"
grep -qx 'OnUnitInactiveSec=120' "$timer"
grep -qx 'RandomizedDelaySec=30' "$timer"
! grep -q 'OnUnitActiveSec' "$timer"
test ! -e "$SYSTEMD_DIR/chief-moa-auto-update.timer.d/interval.conf"
grep -qx 'daemon-reload' "$SYSTEMCTL_LOG"
grep -qx 'enable --now chief-moa-auto-update.timer' "$SYSTEMCTL_LOG"
grep -qx 'list-timers chief-moa-auto-update.timer --no-pager' "$SYSTEMCTL_LOG"

echo "auto-update timer lifecycle tests passed"
