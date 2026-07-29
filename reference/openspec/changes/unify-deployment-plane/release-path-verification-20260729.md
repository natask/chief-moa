# Exact Browser And VPS Release-Path Verification — 2026-07-29

## Intended release

- Repository commit: `c93417fefeb13306ead385641e51f64fbea855b4`
- Browser version: `0.1.125`
- Extension source tree: `78603b3c3b61d39767f0a3a2714316601837c403`
- Package: `browser_extension/dist/Ag-0.1.125.zip`
- Package SHA-256: `f540167c825b3394d69f1f33a16d020629d108767c849785e53e21c4c377ef38`
- Package size: `506490` bytes

The package was rebuilt locally after verification and reproduced the existing
archive byte-for-byte. The archive is ignored build output; the immutable
version, source-tree identity, digest, and size above are its release receipt.

## Release-path result

- The paid 40-minute GitHub-hosted VPS observer is absent.
- VPS CI concurrency is scoped by event and ref and cancels stale same-ref runs.
- Browser release concurrency now cancels stale same-ref runs as well.
- Browser checkout and packaging recheck the exact workflow commit and clean
  extension source tree before and after packaging.
- Browser release evidence binds the full commit, extension source tree,
  version, package digest, and package size.
- Chrome Web Store publication rejects any mismatch in those fields before it
  uploads package bytes.
- `scripts/release/push-master.sh` requires the operator-side public health
  observer to match the exact released commit before reporting gateway success.

## Verification

- `cd browser_extension && npm run verify` — passed, including 189 unit tests
  and the repository source-size policy.
- `cd browser_extension && npm run smoke` — passed in real headless Chrome for
  Testing with the packaged extension source.
- `cd gateway && npm run check` — passed: 1,219 tests passed, one slow test was
  skipped by the standard gate, and every coverage threshold passed.
- `ruby .github/scripts/assert-deploy-vps-contract.rb` — passed.
- `bash scripts/vps/test-wait-for-live-commit.sh` — passed and rejected a
  different commit.
- Browser workflow YAML parsing, shell syntax checks, and `git diff --check` —
  passed.

## Active-state blocker

This execution has no network, credentials, or deploy capability. It therefore
did not upload to Chrome Web Store, signal the user's loaded unpacked browser,
move a remote ref, or query `https://api.agee.app/health`. The package is
verified and the promotion path is exact, but installed-browser and live-VPS
commit confirmation remain intentionally unclaimed. An authorized release
owner must run the protected release path and retain the exact public health
receipt; no hosted observer is needed.
