# Summon the Ag browser companion from anywhere on macOS

This raises Chrome and opens the Ag browser companion when you tap the left
Command key twice from any application. The first tap pair starts one assistant
voice turn on an injectable browser page; the next tap pair sends it. The
extension shows the mascot, the user/reply ribbons, and capture controls.

Two pieces work together:

1. The Chrome extension owns the compact companion, microphone, gateway voice
   socket, browser page evidence, reply presentation, and audio playback.

2. A macOS key listener. A double tap of a bare modifier key cannot be an app
   command, so an OS-level listener is required. This helper uses
   Karabiner-Elements, which is already installed and already has input
   monitoring, so no new binary, LaunchAgent, or extra permission grant is
   needed. The rule emits Chrome's global `Command+Shift+9` extension command
   and raises Chrome.

Why Karabiner and not a Swift CGEventTap binary: both can detect a double Command
tap, but a CGEventTap binary needs its own Accessibility grant and a LaunchAgent
to stay running. Karabiner is already running with the permission it needs, so it
is the lighter path on this machine. If you later remove Karabiner, the
`Swift CGEventTap` note at the bottom describes the fallback.

## Requirements

- Karabiner-Elements installed and running (https://karabiner-elements.pqrs.org/).
- `jq` on PATH (`brew install jq`).
- The unpacked or packaged Ag extension loaded in Chrome with its global command enabled.

## Install

    cd browser_extension/scripts/macos-summon
    ./install.sh

The script writes an importable asset copy, backs up `~/.config/karabiner/karabiner.json`
with an `.agbak.<timestamp>` suffix, then inserts and enables the rule in every
Karabiner profile. Karabiner reloads the config on its own.

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

1. Load the packaged or unpacked Ag extension in Chrome.
2. Run `./install.sh`. Karabiner-Elements > Complex Modifications should now list
   the enabled AG rule.
3. Focus a different app (Finder, Notes, a terminal). Double-tap the left Command
   key. Chrome should raise and show the Ag mascot, transcript/reply ribbons,
   and Cancel/Pause controls. Speak, double-tap again, and confirm the reply.
4. Confirm normal Command usage still works: Cmd+C, Cmd+V, Cmd+Tab, holding
   Command for menu shortcuts, Cmd+click on a link, and Cmd+drag all behave as
   before.
5. Latch regression check: hold Command alone for about half a second, release
   it, then press Cmd+C. It must copy, not open the overlay.

## Uninstall

    ./uninstall.sh

Removes the rule from every profile (after a backup) and deletes the asset copy.
It does not alter any independently configured browser-extension shortcut.

## Troubleshooting

- Double tap does nothing: open Karabiner-Elements > Complex Modifications and
  confirm the AG rule is present and enabled. Re-run `install.sh` if not.
- Chrome raises but Ag does not appear: confirm `open-agee-global` is enabled at
  `chrome://extensions/shortcuts`, then reload the extension.
- Ag appears but does not listen: configure its gateway origin and confirm
  Chrome microphone permission.

## Fallback: Swift CGEventTap (only if you drop Karabiner)

If Karabiner-Elements is not available, a small Swift binary can watch for the
double Command tap with a `CGEventTap` and emit the extension's global shortcut.
That binary
needs Accessibility permission (System Settings > Privacy & Security >
Accessibility) and a LaunchAgent under `~/Library/LaunchAgents` to start at
login. It is heavier than the Karabiner rule, so it is documented here only as
the path to take when Karabiner is not present. Swift and swiftc ship with the
Xcode command line tools already installed on this machine.
