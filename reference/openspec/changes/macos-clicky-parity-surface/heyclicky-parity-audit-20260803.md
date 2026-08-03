# HeyClicky Mac Surface Parity Audit — 2026-08-03

## Evidence inspected

- Installed product: `/Applications/Clicky.app`, display name `HeyClicky`,
  version `1.0.46` (`55`).
- MIT reference source:
  `/Users/natnaelkahssay/projs/nanoclicky/upstream/openclicky`.
- OpenClicky captures covering the docked notch, running agents, parked agents,
  and home interface.
- Shipped Swift symbol and string tables from the installed executable.
- A live launch of HeyClicky. Its current main panels were observed as native
  top-attached 820-by-900 windows on both connected displays.

No binary patch, account mutation, private credential extraction, traffic
interception, or copied product asset was used.

## Recovered product mechanics

HeyClicky's notch surface is an app-owned native window, not content inserted
through a private macOS Dynamic Island API. The implementation pattern is:

1. Run as an `LSUIElement` menu-bar app.
2. Host SwiftUI in a transparent, borderless `NSPanel`.
3. Put the panel above normal windows, join all Spaces, and support full-screen
   auxiliary presentation.
4. Center the initial panel against the physical top edge on a notched built-in
   display and retain a user-moved position afterward.
5. Change Home/Agents content while retaining one panel identity.

The installed binary exposes current types named `NotchPanel`,
`NotchPanelContentView`, `NotchHomeTab`, `NotchAgentsTab`,
`NotchAgentSurface`, and `FloatingAgentChip`. Its Home surface includes an
upcoming-calendar section. Its Agents surface includes search, running rows,
activity timelines, recent thread rows, artifacts, status chips, and open-agent
actions.

The parked-agent rail is a second transparent floating `NSPanel`. OpenClicky
keeps at most six task avatars, uses an icon-only resting state, expands detail
on hover, and places the strip along a screen edge. The main workspace and rail
share one observable agent-session model.

## Chief Moa adaptation

Ag now uses a movable 820-point native panel with Home and Agents modes. Agents
mode uses a Clicky-style project sidebar and a selected-run detail workspace.
It adds:

- Authenticated, bounded `GET /v1/agent/runs?limit=25` projection.
- Running and recent project groups, search, status, current activity, metadata,
  refresh, and authenticated stop requests.
- A second transparent all-Spaces parked-agent rail with up to six avatars.
- Four-second projection refresh while Ag is running.
- Saved user movement with an explicit Reset panel position command.

Chief Moa does not create an OpenClicky-style local Codex database. The gateway
remains authoritative for run state, and the Mac renders returned text as inert
presentation. It does not copy HeyClicky branding, artwork, prompts, telemetry,
service routes, subscription logic, provider credentials, or bundled runtime.

## Remaining parity

The current slice shows canonical run summaries. Full run-event timelines,
artifact opening, retained audio attachments, hover detail cards, rail dragging,
and calendar-event presentation remain separately reviewable work.
