#!/usr/bin/env bash
# Install the systemd service + timer that runs auto-update.sh every two
# minutes on the VPS. Run once on the droplet as root:
#
#   bash /opt/chief-moa/app/scripts/vps/install-auto-update.sh
#
# Logs: journalctl -u chief-moa-auto-update.service

set -euo pipefail

APP_DIR="${MOA_VPS_APP_DIR:-/opt/chief-moa/app}"

cat > /etc/systemd/system/chief-moa-auto-update.service <<UNIT
[Unit]
Description=Promote chief-moa gateway to CI-verified origin/vps-deploy
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
Environment=MOA_VPS_APP_DIR=$APP_DIR
ExecStart=/usr/bin/bash $APP_DIR/scripts/vps/auto-update.sh
UNIT

cat > /etc/systemd/system/chief-moa-auto-update.timer <<UNIT
[Unit]
Description=Poll origin/vps-deploy for CI-verified gateway promotions

[Timer]
OnBootSec=90
OnUnitActiveSec=120
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now chief-moa-auto-update.timer
systemctl list-timers chief-moa-auto-update.timer --no-pager
echo "Auto-update timer installed."
