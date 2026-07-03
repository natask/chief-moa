## Why

The gateway runs today on one ZeroTier main machine. It uses a single
`MOA_GATEWAY_TOKEN` bearer token, a JSON/JSONL plus Postgres hybrid store, and a
systemd user unit synced by rsync over SSH. That works for one owner on a
private network, but the phone and browser can only reach the gateway while they
share the ZeroTier network, and every write is attributed to one anonymous
owner.

The user wants the gateway to run remotely on a VPS so it is always reachable
from the phone and browser, wants a real database and per-user auth through
better-auth, wants the frontend surfaces on Cloudflare where agee.app already
lives, and wants the same server to stay easy to self-host on any VPS from one
image plus env.

This follows the saved product strategy: hosted-default-paid, with BYOK and
self-host as config on one image. The hosted target is a DigitalOcean droplet.
Scaling is deferred.

## What

- Ship one deployable gateway image (Docker) with env-driven modes: `local`,
  `self-host`, and `hosted`. No fork between hosted and self-host code.
- Progress auth from the single `MOA_GATEWAY_TOKEN` to better-auth issuing
  per-user sessions and per-device tokens, behind a flag, with a migration path
  that keeps the token working until every client is registered.
- Require a `DATABASE_URL` Postgres store in remote modes. Keep the JSON/JSONL
  fallback for local dev only.
- Move `DATA_DIR` blobs (OTA APKs, voice audio) onto a persistent volume now, and
  note S3-compatible object storage as the later step.
- Keep harness execution off the VPS. The remote gateway queues agent runs; the
  user's execution machine connects out to the gateway and pulls runs to claim,
  so no inbound port opens on the user's machine.
- Split the frontend onto Cloudflare Pages and keep the gateway API and voice
  WebSocket on the VPS behind proxied Cloudflare DNS. Do not run the gateway in
  Workers.
- Start voice as a single sticky instance. Defer WebSocket scaling.
- Keep secrets in an env file on the VPS for now, and keep harness credentials
  off any host mount.
- Add Postgres dump plus `DATA_DIR` snapshot before any promotion, with a
  restore check.
- Integrate the committed lane contracts for account connections, worker-pull
  execution, client onboarding, voice work history, backup/restore, operations
  runbooks, and product packaging into the main OpenSpec plan.

Committed artifacts now include the gateway Docker/Compose scaffold, backup and
restore scripts, the Cloudflare/DigitalOcean/Railway runbooks, Android/browser
onboarding notes, the account-connection and worker-pull contracts, the voice
work-history control-plane contract, and the first self-host/product packaging
journey. These are preview/spec/scaffold outputs. They do not mean an active
deployment was applied, an active URL was switched, a live service was restarted,
an OTA was published, or a browser extension was reloaded.

## Non-Goals

- Do not run the gateway process inside Cloudflare Workers. Workers cannot hold
  the long-lived voice WebSocket or the Node harness boundary the gateway needs.
- Do not run agent harnesses (Codex, Claude, Gemini) on the VPS. Harness
  execution stays on the user's execution machine.
- Do not build multi-instance voice scaling, load balancing, or session
  affinity beyond one sticky instance yet.
- Do not move S3-compatible object storage in this change. Persistent volume
  first; object storage is a named later step.
- Do not remove the single-token path until device registration covers the
  phone and extension.

## Impact

- Deployment gains a container image and a remote VPS target next to the current
  main-machine rsync path.
- Auth gains users, sessions, and per-device tokens without changing the client
  trust boundary: Android and the extension still hold only a gateway URL and a
  token.
- Account connections become a gateway-owned credential-health surface:
  providers, labels, statuses, refresh/reauth actions, and audit events are
  visible to clients, while raw provider credentials remain server-side.
- Storage requires Postgres in remote modes, so hosted and self-hosted runs use
  the same data model.
- The execution machine changes from an inbound harness host to an outbound
  worker that claims queued runs with a scoped worker token and bounded payloads
  that exclude shell/env/credential authority.
- The frontend moves to Cloudflare Pages; the API and voice WebSocket stay on
  the VPS behind Cloudflare DNS.
- Client onboarding changes from "save whichever ZeroTier URL works" to a
  stable HTTPS gateway origin plus separate reachability, auth, and voice
  diagnostics.
- Operations now have explicit preview runbooks and a backup/restore promotion
  gate before any active service mutation.
