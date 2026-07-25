#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install_root="${MOA_CODEX_INTENT_INSTALL_DIR:-${HOME}/.local/share/chief-moa/codex-intent-launcher}"
bin_dir="${MOA_CODEX_INTENT_BIN_DIR:-${HOME}/.local/bin}"

mkdir -p "$install_root" "$bin_dir"
chmod 700 "$install_root"
install -m 700 "$script_dir/cli.js" "$install_root/cli.js"
install -m 600 "$script_dir/lib.js" "$install_root/lib.js"
ln -sfn "$install_root/cli.js" "$bin_dir/moa-codex-intent"

printf 'Installed %s\n' "$bin_dir/moa-codex-intent"
printf 'Set MOA_GATEWAY_URL and MOA_GATEWAY_TOKEN before launching work.\n'
