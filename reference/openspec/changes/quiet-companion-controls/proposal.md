# Quiet companion controls

## Why

Ag should stay available without covering the work. A user should see that Ag is listening or working, copy the latest spoken text, and stop spoken replies without opening a panel.

The wider product also needs one path from discovery to daily use. That path does not exist yet. The public site, account sign-in, client enrollment, downloads, companion settings, intent history, run history, and usage data live in separate partial changes and surfaces.

## What changes

- Keep the companion movable and small.
- Keep only Copy and voice reply on/off beside the companion.
- Stop local assistant audio as soon as the user turns voice replies off.
- Keep listening, thinking, and speaking feedback on the companion and bounded ribbons.
- Preserve transcript history in the gateway and full control surfaces.
- Define staged tickets for public trial, one account system, client enrollment, downloads, and the control center.

## Boundaries

- The browser owns browser UI, clipboard writes, microphone capture, and audio playback.
- Android owns phone UI, permissions, actions, and receipts.
- The gateway owns accounts, sessions, history, runs, usage records, and provider credentials.
- A mute or stop control acts locally before any model round trip.
- This change does not add another account store or place a gateway token in website JavaScript.

## First observable slice

On any supported page, the browser companion shows Copy and voice controls while its text panel is closed. Copy writes the latest spoken transcript, with the latest reply as a fallback. Turning voice off stops current local playback and blocks later audio frames until the user turns voice on.
