# Production Mac Device Sign-In — 2026-08-02

## User direction

Make the existing Mac Sign In control work end to end against production. Do
not stop at source implementation or describe the production gap as somebody
else's operational problem.

## Reconciled gap

The Mac client already implements the RFC 8628-style device flow and dedicated
Keychain session storage. The production gateway still runs legacy
`gateway-token` mode. Before this change, its image omitted `auth.mjs` and the
gateway migrations, Compose did not pass Better Auth configuration, the active
database had no auth tables, and the production device/sign-in pages returned
404. Therefore task 1.6 was source-complete but not operationally accepted.

## Authorized staged implementation

1. Copy the auth runtime and additive migrations into the production image.
2. Run the migration journal in a one-shot Compose service before gateway boot.
3. Pass the five declared Better Auth settings while retaining the legacy
   gateway bearer as a predecessor-compatible owner bridge.
4. In the isolated VPS preview, create the restricted owner, claim and approve
   a Mac device code, exchange it for a device bearer, authenticate a protected
   gateway read, and mint a voice WebSocket ticket.
5. Prepare production configuration without activation, prove the isolated
   state stores and predecessor-readable migration, promote the additive
   schema/image while preserving the active Postgres and named volumes, then
   explicitly enable Better Auth and recreate only the gateway while it is
   drain-safe.
6. Require a real owner browser approval and portable Mac auth-file session before calling
   the production surface accepted.

## Portable credential-cache follow-up — 2026-08-03

The production device flow remains unchanged, but the native client no longer
binds its returned bearer to macOS Keychain. Ag follows Codex's portable file
credential-cache model: `AG_HOME/auth.json`, default `~/.ag/auth.json`, is an
atomic, owner-only password-equivalent cache. Explicit disconnect removes it.
This preserves browser/device sign-in while making the session-store contract
portable to future non-Mac native clients.

The browser and Mac feedback contract is explicit: approval is an intermediate
state, not proof of connection. The browser waits until the app consumes the
device authorization before it says “Ag is connected,” while the native card
shows the code and waiting state and then changes to connected or a specific
terminal failure.

Developer ID signing, notarization, universal packaging, and installation/TCC
promotion remain separate Mac distribution gates; they do not block proving the
account and device-session path.
