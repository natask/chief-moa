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
6. Require a real owner browser approval and Mac Keychain session before calling
   the production surface accepted.

Developer ID signing, notarization, universal packaging, and installation/TCC
promotion remain separate Mac distribution gates; they do not block proving the
account and device-session path.
