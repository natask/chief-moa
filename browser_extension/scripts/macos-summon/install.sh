#!/usr/bin/env bash
set -euo pipefail

# Install the "double-tap Command to summon AG" Karabiner-Elements rule.
#
# What it does: registers a complex-modification rule that opens the native
# Ag.app when you tap the left Command key twice quickly. Normal Command
# shortcuts keep working because the rule only acts on a solo double tap.
#
# Idempotent. Backs up karabiner.json before any change. Safe to re-run.
#
# Override: KARABINER_CONFIG_DIR (default: ~/.config/karabiner)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RULE_FILE="$HERE/ag-double-command.json"
KARABINER_DIR="${KARABINER_CONFIG_DIR:-$HOME/.config/karabiner}"
KARABINER_JSON="$KARABINER_DIR/karabiner.json"
ASSETS_DIR="$KARABINER_DIR/assets/complex_modifications"

DESC="Double-tap Left Command to open the native Ag companion"
LEGACY_DESC="Double-tap Left Command to raise Chrome and open the AG overlay"

command -v jq >/dev/null 2>&1 || { echo "error: jq is required (brew install jq)"; exit 1; }
[ -f "$RULE_FILE" ] || { echo "error: rule file not found: $RULE_FILE"; exit 1; }

if [ ! -d "/Applications/Karabiner-Elements.app" ] && [ ! -f "$KARABINER_JSON" ]; then
  echo "error: Karabiner-Elements is not installed."
  echo "       Install it from https://karabiner-elements.pqrs.org/ then re-run."
  exit 1
fi

RULE_JSON="$(jq '.rules[0]' "$RULE_FILE")"

# Publish an importable asset copy so the Karabiner UI also lists the rule.
mkdir -p "$ASSETS_DIR"
jq -n --argjson rule "$RULE_JSON" '{title: "Ag native Mac companion summon", rules: [$rule]}' \
  > "$ASSETS_DIR/ag-double-command.json"
echo "wrote asset: $ASSETS_DIR/ag-double-command.json"

if [ ! -f "$KARABINER_JSON" ]; then
  echo "note: $KARABINER_JSON does not exist yet."
  echo "      Open Karabiner-Elements once to create it, then re-run this script,"
  echo "      or enable the rule via Complex Modifications > Add rule."
  exit 0
fi

# Validate and back up the live config before touching it.
jq empty "$KARABINER_JSON" || { echo "error: $KARABINER_JSON is not valid JSON; aborting."; exit 1; }
BACKUP="$KARABINER_JSON.agbak.$(date +%Y%m%d%H%M%S).$$"
cp "$KARABINER_JSON" "$BACKUP"
echo "backed up config: $BACKUP"

# Replace any earlier copy (match by description) and enable it in every profile.
TMP="$(mktemp)"
jq --argjson rule "$RULE_JSON" --arg desc "$DESC" --arg legacy "$LEGACY_DESC" '
  .profiles |= map(
    .complex_modifications.rules = (
      ((.complex_modifications.rules // [])
        | map(select(.description != $desc and .description != $legacy))) + [$rule]
    )
  )
' "$KARABINER_JSON" > "$TMP"

jq empty "$TMP" || { echo "error: produced invalid JSON; leaving config untouched."; rm -f "$TMP"; exit 1; }
mv "$TMP" "$KARABINER_JSON"
echo "installed and enabled rule in all profiles: $DESC"
echo
echo "Karabiner-Elements reloads the config automatically."
echo "Double-tap the left Command key from any app to summon native Ag.app."
