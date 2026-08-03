#!/usr/bin/env bash
# Install the systemd service + completion-relative timer that runs
# auto-update.sh after boot and two minutes after each prior run finishes.
# Run once on the droplet as root:
#
#   bash /opt/chief-moa/app/scripts/vps/install-auto-update.sh
#
# Logs: journalctl -u chief-moa-auto-update.service

set -euo pipefail

APP_DIR="${MOA_VPS_APP_DIR:-/opt/chief-moa/app}"
SYSTEMD_DIR="${MOA_SYSTEMD_DIR:-/etc/systemd/system}"
SERVICE_UNIT="$SYSTEMD_DIR/chief-moa-auto-update.service"
TIMER_UNIT="$SYSTEMD_DIR/chief-moa-auto-update.timer"
LEGACY_INTERVAL_DROP_IN="$SYSTEMD_DIR/chief-moa-auto-update.timer.d/interval.conf"

mkdir -p "$SYSTEMD_DIR"

cat > "$SERVICE_UNIT" <<UNIT
[Unit]
Description=Promote chief-moa gateway to CI-verified origin/vps-deploy
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
Environment=MOA_VPS_APP_DIR=$APP_DIR
ExecStart=/usr/bin/bash $APP_DIR/scripts/vps/auto-update.sh
UNIT

cat > "$TIMER_UNIT" <<UNIT
[Unit]
Description=Poll origin/vps-deploy for CI-verified gateway promotions

[Timer]
OnBootSec=90
# Schedule only after the prior oneshot service becomes inactive. An
# activation-relative timer can elapse during a long preview/build and collide
# with the promotion that caused it.
OnUnitInactiveSec=120
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
UNIT

# A 2026-07-31 host hotfix lengthened the old activation-relative schedule in
# a drop-in. Keeping it would reintroduce a second independent trigger beside
# OnUnitInactiveSec, so the canonical installer retires that exact override.
rm -f -- "$LEGACY_INTERVAL_DROP_IN"

systemctl daemon-reload
systemctl enable --now chief-moa-auto-update.timer
systemctl list-timers chief-moa-auto-update.timer --no-pager
echo "Auto-update timer installed."
