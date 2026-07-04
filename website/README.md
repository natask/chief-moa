# A.G. website

The public A.G. site: a single landing page with the email field above the
fold, backed by a waitlist signup that stores emails in D1 and sends a
confirmation email via Resend.

- Live: https://agee.app (also https://agee-app.pages.dev)
- Host: Cloudflare Pages (`agee-app`) — this project owns the agee.app custom
  domain and its validated apex cert. The unused `chief-moa-site` project is a
  spare; it could not get an apex cert without a DNS record we lacked rights to
  create, so the site lives on `agee-app`.
- Store: Cloudflare D1 (`chief-moa-waitlist`), bound as `env.DB`
- Copy source: `reference/scratch/vision/moa-product-vision.md`

## Layout

- `public/index.html` — the landing page and waitlist form (one file, no build step)
- `public/assets/` — deck images and logos
- `functions/api/waitlist.js` — `POST /api/waitlist`: validate, store, email
- `schema.sql` — D1 table
- `wrangler.toml` — Pages config and D1 binding

## Deploy

```sh
cd website
npx wrangler pages deploy --branch main --commit-dirty=true
```

## Turn on the confirmation email

Email capture and storage already work. The confirmation email stays off until
Resend is configured. It needs a domain verified in Resend (the free
`onboarding@resend.dev` sender only delivers to your own account).

1. Verify a domain at https://resend.com/domains and create an API key.
2. Set the secrets on the Pages project:

```sh
npx wrangler pages secret put RESEND_API_KEY --project-name agee-app
npx wrangler pages secret put RESEND_FROM    --project-name agee-app   # e.g. "A.G. <hello@agee.app>"
npx wrangler pages secret put RESEND_REPLY_TO --project-name agee-app  # optional
```

After the secrets are set, new signups get a "Thanks for hopping on the
waitlist" email. The API reports `emailed: true` when it sent.

## Read the waitlist

```sh
npx wrangler d1 execute chief-moa-waitlist --remote \
  --command "SELECT email, created_at FROM waitlist ORDER BY created_at DESC;"
```

## Local dev

```sh
cp .dev.vars.example .dev.vars   # add a real Resend key to test email locally
npx wrangler pages dev public
```
