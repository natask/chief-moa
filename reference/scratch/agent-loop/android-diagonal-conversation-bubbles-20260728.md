# Android diagonal conversation bubbles ticket

## Observable outcome

The compact overlay reads like a bounded mobile conversation around the
companion: the current user turn hangs above/right, the current assistant turn
hangs below/left, and both remain on-screen.

## Acceptance checks

- The user bubble's left edge and assistant bubble's right edge meet the
  companion centerline when space permits; narrow layouts clamp inward.
- Collapsed text is capped at five wrapped lines. Expanded text is height-bounded
  and vertically scrollable.
- A populated user bubble always paints one Copy action and one separate History
  action. There is no double-tap action and no Copy row in a hidden menu.
- Touch and Android 8 accessibility can invoke expansion, Copy, and History.
- Transparent space outside the compact overlay root remains pass-through; the
  API 26 compact-box fallback does not prevent startup.
- Android focused tests, the full JVM suite, and `assembleDebug` pass.

Live voice placeholders and spoken-word highlighting are separate units and are
not part of this geometry/action ticket.
