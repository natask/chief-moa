# Dictate with AG from anywhere on macOS (double-tap Command)

This raises Chrome and starts AG dictation when you tap the left Command key
twice quickly, from any application, even when Chrome is not focused. Double-tap
Command again to stop. AG copies the literal mixed-language transcript to the
clipboard without running the reasoning or text-to-speech stages.

Two pieces work together:

1. A global Chrome command in the extension. The manifest registers
   `open-agee-global` with `"global": true` at Command+Shift+9. Chrome routes a
   global command to the extension even when Chrome is not the focused app (since
   Chrome 35). The background worker resolves an injectable tab in the
   last-focused window, focuses it, and starts dictation. If the active tab is a
   page the overlay cannot inject into (a `chrome://` page, the Web Store, a PDF),
   it picks another web tab, or creates one.

2. A macOS key listener. A double tap of a bare modifier key cannot be a Chrome
   command, so an OS-level listener is required. This helper uses
   Karabiner-Elements, which is already installed and already has input
   monitoring, so no new binary, LaunchAgent, or extra permission grant is
   needed. The rule fires Command+Shift+9 (which the global Chrome command
   catches) and runs `open -a "Google Chrome"` to bring Chrome forward.

Why Karabiner and not a Swift CGEventTap binary: both can detect a double Command
tap, but a CGEventTap binary needs its own Accessibility grant and a LaunchAgent
to stay running. Karabiner is already running with the permission it needs, so it
is the lighter path on this machine. If you later remove Karabiner, the
`Swift CGEventTap` note at the bottom describes the fallback.

## Requirements

- Karabiner-Elements installed and running (https://karabiner-elements.pqrs.org/).
- `jq` on PATH (`brew install jq`).
- The AG extension loaded in Chrome (the global command ships in its manifest).

## Install

    cd browser_extension/scripts/macos-summon
    ./install.sh

The script writes an importable asset copy, backs up `~/.config/karabiner/karabiner.json`
with an `.agbak.<timestamp>` suffix, then inserts and enables the rule in every
Karabiner profile. Karabiner reloads the config on its own.

Overrides:

    AG_CHROME_APP="Google Chrome Beta" ./install.sh   # raise a different Chrome
    AG_SUMMON_KEY="8" ./install.sh                     # use Command+Shift+8 instead

If you change `AG_SUMMON_KEY`, also change the extension shortcut to match at
`chrome://extensions/shortcuts` (the digit must be the same on both sides).

## Permissions

Karabiner already holds the Input Monitoring permission it needs. macOS may show
a one-time prompt the first time the rule runs `open -a`; allow it. No new
Accessibility grant is required for this helper because the keystroke is emitted
by Karabiner's virtual keyboard, not by a scripting bridge.

## How the double tap stays safe

The rule has two manipulators. The second passes Command through unchanged and
arms a short-lived variable on every Command key-down. The variable clears
after 300 ms, or as soon as any other key is pressed. The first manipulator
fires the summon only when Command is pressed while the variable is armed,
which means a second tap within 300 ms of the first. Any key pressed between
the taps disarms it, so held combinations like Cmd+C, Cmd+Tab, and
Cmd+Shift+anything are untouched. Command is emitted immediately (not lazily),
so Cmd+click and Cmd+drag also keep working. Tune the window by editing
`basic.to_delayed_action_delay_milliseconds` in `ag-double-command.json` and
re-running `install.sh`.

One inherent tradeoff of any double-tap trigger: a solo Command tap followed
within 300 ms by a Command shortcut reads as a double tap. Shrink the window if
that ever bites.

## Manual QA (the hotkey cannot be verified headlessly)

1. Load the extension unpacked in Chrome (or reload it after this change).
2. Open `chrome://extensions/shortcuts`. Confirm AG lists
   "Open AG overlay from any app while Chrome is running" bound to
   Command+Shift+9 with scope Global. If scope shows "In Chrome", click the scope
   selector and set it to Global.
3. First, test the Chrome side alone: with a normal web page focused in Chrome,
   press Command+Shift+9. The AG overlay should open.
4. Run `./install.sh`. Karabiner-Elements > Complex Modifications should now list
   the enabled AG rule.
5. Focus a different app (Finder, Notes, a terminal). Double-tap the left Command
   key. Chrome should come forward and AG should start listening on the active
   web tab. Speak, double-tap Command again, return to the original app, and
   paste the copied transcript.
6. Switch Chrome's active tab to a `chrome://` page (for example
   `chrome://settings`). From another app, double-tap Command again. AG should
   open on another web tab, or open a new tab, instead of failing on the
   non-injectable page.
7. Confirm normal Command usage still works: Cmd+C, Cmd+V, Cmd+Tab, holding
   Command for menu shortcuts, Cmd+click on a link, and Cmd+drag all behave as
   before.
8. Latch regression check: hold Command alone for about half a second, release
   it, then press Cmd+C. It must copy, not open the overlay.

## Uninstall

    ./uninstall.sh

Removes the rule from every profile (after a backup) and deletes the asset copy.
The Chrome global shortcut stays registered in the extension; remove it at
`chrome://extensions/shortcuts` if you no longer want it.

## Troubleshooting

- Double tap does nothing: open Karabiner-Elements > Complex Modifications and
  confirm the AG rule is present and enabled. Re-run `install.sh` if not.
- Overlay opens but Chrome stays behind: the `open -a` app name does not match
  your Chrome. Re-run with `AG_CHROME_APP="<your Chrome app name>"`.
- Command+Shift+9 conflicts with something else: re-run with a different
  `AG_SUMMON_KEY` (a single digit 0-9) and set the same digit at
  `chrome://extensions/shortcuts`. Global Chrome shortcuts are limited to
  Command+Shift+[0-9], so the trigger must stay a digit.
- Nothing happens from other apps but Command+Shift+9 works inside Chrome: the
  extension shortcut is scoped "In Chrome" rather than Global. Fix it at
  `chrome://extensions/shortcuts`.

## Fallback: Swift CGEventTap (only if you drop Karabiner)

If Karabiner-Elements is not available, a small Swift binary can watch for the
double Command tap with a `CGEventTap` and run the same two actions (emit
Command+Shift+9 with `CGEvent`, then `open -a "Google Chrome"`). That binary
needs Accessibility permission (System Settings > Privacy & Security >
Accessibility) and a LaunchAgent under `~/Library/LaunchAgents` to start at
login. It is heavier than the Karabiner rule, so it is documented here only as
the path to take when Karabiner is not present. Swift and swiftc ship with the
Xcode command line tools already installed on this machine.
