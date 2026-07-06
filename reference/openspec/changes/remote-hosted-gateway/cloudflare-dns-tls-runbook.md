# Cloudflare DNS And TLS Runbook

Last reviewed: 2026-07-03.

This runbook describes the public edge for the remote-hosted gateway preview.
It does not approve active promotion. Do not switch the active client URL,
restart an active service, or apply a deployment until the backup and restore
gate, preview smoke, rollback, no-interruption, and state-compatibility checks
have passed.

## Target Topology

```text
Cloudflare Pages
  agee.app or app.<domain>
  static marketing/app shell from the existing Pages project

Cloudflare DNS proxy
  api.<domain>
  A/AAAA record to the VPS public address, proxied

VPS origin
  reverse proxy on 443
  gateway container listening on 127.0.0.1:8787
  Postgres and DATA_DIR stay on the VPS volume
```

The split is intentional:

- Pages serves only static/data-driven frontend surfaces.
- `api.<domain>` serves gateway HTTP APIs and `wss://` voice sessions.
- The gateway does not run in Cloudflare Workers.
- Android and the browser extension store only the stable gateway URL plus
  their token.

## Cloudflare Pages Domain

1. In Cloudflare Workers & Pages, open the existing Pages project, currently
   expected to be `agee-app`.
2. Add the desired frontend custom domain, for example `agee.app` or
   `app.<domain>`.
3. If the zone is managed in Cloudflare, let Pages create or validate the Pages
   DNS record. If DNS is elsewhere, create the CNAME that Pages requests.
4. Do not point `api.<domain>` at the Pages project.

Pages smoke:

```sh
curl -fsSI https://agee.app
curl -fsS https://agee.app | head
```

The frontend may call `https://api.<domain>`, but it must not proxy API or
voice traffic through Pages.

## API DNS Record

Create the gateway hostname under Cloudflare DNS:

```text
Type: A
Name: api
Content: <vps-ipv4>
Proxy status: Proxied
TTL: Auto
```

If the VPS has IPv6, add a matching `AAAA` record and keep it proxied. Use an
orange-cloud proxied record for normal operation. Use gray-cloud DNS-only only
for short origin debugging, and remember that Cloudflare Origin CA certificates
are not trusted by browsers when the proxy is bypassed.

Cloudflare only proxies standard HTTP/HTTPS ports and a fixed set of alternate
ports. Keep the public edge on `https://api.<domain>` port 443 and reverse
proxy to the gateway container on `127.0.0.1:8787`; do not expose port `8787`
as the public client URL.

Recommended VPS bind for the gateway container when a host reverse proxy owns
TLS:

```env
GATEWAY_BIND=127.0.0.1
GATEWAY_PORT=8787
```

## Proxied WebSocket Behavior

Cloudflare supports proxied WebSocket connections for orange-cloud records. For
Chief Moa, the client-facing voice URL is:

```text
wss://api.<domain>/v1/voice/sessions
```

The browser extension normally mints a short-lived ticket first:

```text
POST https://api.<domain>/v1/voice/session-ticket
```

The ticket response must return a `wss://api.<domain>/v1/voice/sessions?ticket=`
URL. The gateway builds that URL from `x-forwarded-proto`,
`x-forwarded-host`, and `host`, so the origin reverse proxy must preserve
forwarded headers.

Operational notes:

- Confirm the Cloudflare Network setting for WebSockets is enabled.
- The initial HTTP upgrade request is still subject to WAF/rate-limit rules.
- After the `101 Switching Protocols` upgrade, the established stream is not
  inspected like normal HTTP request bodies.
- Implement or keep client/provider heartbeats because idle WebSockets can be
  closed by the edge, origin, or client network.
- Single gateway instance is the first supported voice shape. If a later
  Cloudflare Load Balancer is introduced, enable session affinity before
  adding more voice origins.

## Origin TLS Options

Use Full (strict) whenever possible.

### Option A: Public Origin Certificate

Use Caddy, nginx plus Certbot, or another ACME client to issue a public
certificate for `api.<domain>` on the VPS. This is the easiest option when
operators need direct origin diagnostics without browser trust warnings.

Minimal Caddy shape:

```caddyfile
api.<domain> {
  reverse_proxy 127.0.0.1:8787
}
```

Cloudflare SSL/TLS mode:

```text
Full (strict)
```

### Option B: Cloudflare Origin CA Certificate

Create an Origin CA certificate in Cloudflare for `api.<domain>` or
`*.<domain>`, install the certificate and private key on the
VPS reverse proxy, and set SSL/TLS mode to Full (strict).

Use this only when the hostname stays proxied. Browsers do not trust
Cloudflare Origin CA certificates directly if the record is gray-clouded or
Cloudflare is paused. Track certificate expiry yourself.

### Option C: Temporary Full Mode

Full mode can be used only as a short bootstrap step while an origin
certificate is being installed. It encrypts the Cloudflare-to-origin leg but
does not validate the origin certificate. Do not leave production or active
client traffic on Full mode, and do not use Flexible mode for the gateway.

## Origin Firewall

Recommended firewall posture:

- Allow SSH only from operator IPs or a locked-down admin path.
- Allow inbound `80` and `443` for the reverse proxy. Restrict to Cloudflare IP
  ranges if the operations team is ready to maintain that list.
- Block public inbound `5432`.
- Block public inbound `8787`; keep the gateway bound to `127.0.0.1` behind the
  reverse proxy.
- Do not mount harness credentials into the gateway host or container.

## Smoke Checks

Run these after the VPS stack and reverse proxy are up, but before any active
client URL promotion.

DNS resolves through Cloudflare:

```sh
dig +short api.<domain>
curl -fsSI https://api.<domain>
```

Gateway health:

```sh
curl -fsS https://api.<domain>/health
```

Token gate still protects privileged routes:

```sh
curl -i https://api.<domain>/v1/agent/runs
```

Expected unauthenticated result is `401` unless a future auth migration changes
the route to a better-auth session requirement.

Voice ticket uses `wss://` and the public host:

```sh
curl -fsS \
  -X POST \
  -H "authorization: Bearer $MOA_GATEWAY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"source":"cloudflare-smoke"}' \
  https://api.<domain>/v1/voice/session-ticket
```

Direct voice WebSocket smoke from this repo:

```sh
node gateway/deploy/main-machine/smoke-voice-session.js \
  wss://api.<domain>/v1/voice/sessions \
  "$MOA_GATEWAY_TOKEN"
```

Full gateway smoke when OTA and real voice are intentionally configured:

```sh
cd gateway
MOA_GATEWAY_TOKEN="$MOA_GATEWAY_TOKEN" \
  npm run smoke:main-machine -- https://api.<domain>
```

Pass criteria:

- `/health` returns `ok: true`.
- The ticket endpoint returns `ws_url` beginning with `wss://api.<domain>/`.
- The WebSocket smoke sees `session_ready`, `transcript_final`,
  `assistant_audio_start`, `assistant_audio_done`, and `turn_done`.
- Pages remains reachable at the frontend hostname and does not serve the API
  subdomain.

## Promotion Gate

Promotion is blocked until all of the following are true:

- Postgres dump exists.
- `DATA_DIR` snapshot/archive exists.
- The dump and data snapshot restore into a scratch target.
- Scratch target passes `/health` and one core read path.
- User explicitly approves switching the active gateway URL or restarting the
  active service in the current turn.

## External References

- Cloudflare proxied WebSockets:
  https://developers.cloudflare.com/network/websockets/
- Cloudflare DNS records:
  https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/
- Cloudflare proxied ports:
  https://developers.cloudflare.com/fundamentals/reference/network-ports/
- Cloudflare Full (strict):
  https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/
- Cloudflare Origin CA:
  https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/
- Cloudflare Pages custom domains:
  https://developers.cloudflare.com/pages/configuration/custom-domains/
