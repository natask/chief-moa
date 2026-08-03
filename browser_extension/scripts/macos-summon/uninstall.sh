#!/usr/bin/env bash
set -euo pipefail

# Remove the "double-tap Command to summon Ag" Karabiner-Elements rule.
# Backs up karabiner.json before any change. Safe to re-run.

KARABINER_DIR="${KARABINER_CONFIG_DIR:-$HOME/.config/karabiner}"
KARABINER_JSON="$KARABINER_DIR/karabiner.json"
ASSETS_DIR="$KARABINER_DIR/assets/complex_modifications"
DESC_PREFIX="Double-tap Left Command"

command -v jq >/dev/null 2>&1 || { echo "error: jq is required"; exit 1; }

if [ -f "$ASSETS_DIR/ag-double-command.json" ]; then
  rm -f "$ASSETS_DIR/ag-double-command.json"
  echo "removed asset: $ASSETS_DIR/ag-double-command.json"
fi

if [ -f "$KARABINER_JSON" ]; then
  jq empty "$KARABINER_JSON" || { echo "error: $KARABINER_JSON is not valid JSON; aborting."; exit 1; }
  BACKUP="$KARABINER_JSON.agbak.$(date +%Y%m%d%H%M%S).$$"
  cp "$KARABINER_JSON" "$BACKUP"
  echo "backed up config: $BACKUP"

  TMP="$(mktemp)"
  jq --arg prefix "$DESC_PREFIX" '
    .profiles |= map(
      .complex_modifications.rules = (
        (.complex_modifications.rules // [])
        | map(select(
            ((.description // "") | startswith($prefix)) | not
          ))
      )
    )
  ' "$KARABINER_JSON" > "$TMP"

  jq empty "$TMP" || { echo "error: produced invalid JSON; leaving config untouched."; rm -f "$TMP"; exit 1; }
  mv "$TMP" "$KARABINER_JSON"
  echo "removed the AG double-tap rule from all profiles."
fi

echo "done. Karabiner-Elements reloads the config automatically."
