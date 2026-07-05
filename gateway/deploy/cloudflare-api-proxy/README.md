# api.agee.app Worker proxy

Cloudflare Worker that passes all HTTP and WebSocket traffic for
`api.agee.app` through to the VPS gateway origin
(`chief-moa.143.198.226.83.sslip.io`, Caddy TLS).

Why a Worker and not a plain A record: the wrangler OAuth token on the
deploy machine has DNS read-only scope, so it cannot create `dns_records`.
A Workers custom domain creates the DNS record and edge certificate itself.

Deploy: `npx wrangler deploy` from this directory.

The gateway advertises `PUBLIC_GATEWAY_URL=https://api.agee.app` (set in
`/opt/chief-moa/gateway.env` on the VPS) so voice ticket `ws_url` values use
the public host.

Replace this Worker with a proxied A record `api -> 143.198.226.83` once a
Cloudflare token with Zone:DNS:Edit for agee.app exists; the origin needs no
change.
