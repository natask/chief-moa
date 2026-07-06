#!/usr/bin/env bash
set -euo pipefail

# Install the "double-tap Command to summon A.G." Karabiner-Elements rule.
#
# What it does: registers a complex-modification rule that fires the A.G. global
# Chrome command (Command+Shift+9) and raises Chrome when you tap the left
# Command key twice quickly. Normal Command shortcuts (Cmd+C, Cmd+Tab, ...) keep
# working because the rule only acts on a solo double tap.
#
# Idempotent. Backs up karabiner.json before any change. Safe to re-run.
#
# Overrides (env vars):
#   AG_CHROME_APP   application to raise      (default: "Google Chrome")
#   AG_SUMMON_KEY   digit for the Chrome global command (default: "9")
#   KARABINER_CONFIG_DIR   config dir         (default: ~/.config/karabiner)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RULE_FILE="$HERE/ag-double-command.json"
KARABINER_DIR="${KARABINER_CONFIG_DIR:-$HOME/.config/karabiner}"
KARABINER_JSON="$KARABINER_DIR/karabiner.json"
ASSETS_DIR="$KARABINER_DIR/assets/complex_modifications"

CHROME_APP="${AG_CHROME_APP:-Google Chrome}"
SUMMON_KEY="${AG_SUMMON_KEY:-9}"
DESC="Double-tap Left Command to raise Chrome and open the A.G. overlay"

command -v jq >/dev/null 2>&1 || { echo "error: jq is required (brew install jq)"; exit 1; }
[ -f "$RULE_FILE" ] || { echo "error: rule file not found: $RULE_FILE"; exit 1; }

if [ ! -d "/Applications/Karabiner-Elements.app" ] && [ ! -f "$KARABINER_JSON" ]; then
  echo "error: Karabiner-Elements is not installed."
  echo "       Install it from https://karabiner-elements.pqrs.org/ then re-run."
  exit 1
fi

SHELL_CMD="open -a '$CHROME_APP'"

# Build the effective rule with the key / app overrides applied.
RULE_JSON="$(jq \
  --arg key "$SUMMON_KEY" \
  --arg cmd "$SHELL_CMD" \
  '.rules[0]
    | (.manipulators[0].to[1].key_code) = $key
    | (.manipulators[0].to[2].shell_command) = $cmd' \
  "$RULE_FILE")"

# Publish an importable asset copy so the Karabiner UI also lists the rule.
mkdir -p "$ASSETS_DIR"
jq -n --argjson rule "$RULE_JSON" '{title: "A.G. double-tap Command summon", rules: [$rule]}' \
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
jq --argjson rule "$RULE_JSON" --arg desc "$DESC" '
  .profiles |= map(
    .complex_modifications.rules = (
      ((.complex_modifications.rules // []) | map(select(.description != $desc))) + [$rule]
    )
  )
' "$KARABINER_JSON" > "$TMP"

jq empty "$TMP" || { echo "error: produced invalid JSON; leaving config untouched."; rm -f "$TMP"; exit 1; }
mv "$TMP" "$KARABINER_JSON"
echo "installed and enabled rule in all profiles: $DESC"
echo
echo "Karabiner-Elements reloads the config automatically."
echo "Double-tap the left Command key from any app to summon the A.G. overlay."
echo "Also confirm A.G. shows Command+Shift+$SUMMON_KEY at chrome://extensions/shortcuts (scope: Global)."
