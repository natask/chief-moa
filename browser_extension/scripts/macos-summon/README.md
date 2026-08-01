# Summon native Ag from anywhere on macOS

This opens the native Ag companion when you tap the left Command key twice from
any application. It does not raise Chrome, inspect a tab, capture the current
page, traverse Accessibility, or capture pixels. Double-tap again to commit the
same native voice turn and hear the gateway-hosted assistant reply.

Two native pieces work together:

1. `Ag.app` owns the compact panel, microphone, gateway voice socket, reply
   presentation, and audio playback. Its normal summon path carries no screen or
   page context.

2. A macOS key listener. A double tap of a bare modifier key cannot be an app
   command, so an OS-level listener is required. This helper uses
   Karabiner-Elements, which is already installed and already has input
   monitoring, so no new binary, LaunchAgent, or extra permission grant is
   needed. The rule runs `open -a "Ag"`; reopening the running app invokes its
   single native panel.

Why Karabiner and not a Swift CGEventTap binary: both can detect a double Command
tap, but a CGEventTap binary needs its own Accessibility grant and a LaunchAgent
to stay running. Karabiner is already running with the permission it needs, so it
is the lighter path on this machine. If you later remove Karabiner, the
`Swift CGEventTap` note at the bottom describes the fallback.

## Requirements

- Karabiner-Elements installed and running (https://karabiner-elements.pqrs.org/).
- `jq` on PATH (`brew install jq`).
- A packaged `Ag.app` installed in `/Applications`.

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

1. Install the packaged native app at `/Applications/Ag.app`.
2. Run `./install.sh`. Karabiner-Elements > Complex Modifications should now list
   the enabled AG rule.
3. Focus a different app (Finder, Notes, a terminal). Double-tap the left Command
   key. Native Ag should appear without Chrome moving or any page-context grant.
   Speak, double-tap again, and confirm visible transcript, reply text, and audio.
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
- macOS says it cannot find Ag: package and install the native app at
  `/Applications/Ag.app`, then retry the gesture.
- Ag appears but does not listen: configure its gateway origin and sign in,
  then confirm macOS microphone permission for Ag in System Settings.

## Fallback: Swift CGEventTap (only if you drop Karabiner)

If Karabiner-Elements is not available, a small Swift binary can watch for the
double Command tap with a `CGEventTap` and run `open -a "Ag"`. That binary
needs Accessibility permission (System Settings > Privacy & Security >
Accessibility) and a LaunchAgent under `~/Library/LaunchAgents` to start at
login. It is heavier than the Karabiner rule, so it is documented here only as
the path to take when Karabiner is not present. Swift and swiftc ship with the
Xcode command line tools already installed on this machine.
