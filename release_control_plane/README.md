# Release Control Plane

This component is the persistent authority boundary above Chief Moa and future
applications. Clients and build/QA runners integrate with it; they do not own
its state or promotion authority.

The component includes a persistence-neutral service, HTTP boundary, Postgres
adapter, and repository release publisher. The publisher accepts only authority
injected by a trusted repository-release host and bound to the exact Git SHA,
source ref, and channel. It verifies exact artifact digests and publication
evidence, then atomically appends the immutable bundle, monotonic channel head,
and audit receipt. Device authentication and caller-supplied manifest fields
cannot grant publication authority.

```sh
npm run check
```

Validate a publication manifest without publishing:

```sh
node bin/release-publisher.mjs check-manifest path/to/publication-manifest.json
```

The guarded operational command is:

```sh
MOA_COMPOSE_ENV_FILE=/path/to/gateway.env \
MOA_REPOSITORY_RELEASE_AUTHORITY_ID=release-ci \
MOA_REPOSITORY_RELEASE_GIT_SHA=<exact-40-character-sha> \
MOA_REPOSITORY_RELEASE_SOURCE_REF=refs/heads/<verified-branch> \
MOA_REPOSITORY_RELEASE_CHANNELS=preview \
scripts/release/publish-release-bundle.sh path/to/publication-manifest.json
```

Stable publication additionally requires
`MOA_REPOSITORY_RELEASE_PROMOTION_BUNDLE_ID` and
`MOA_REPOSITORY_RELEASE_PROMOTION_EVIDENCE_REF`, supplied by the trusted
promotion workflow and bound into the publication receipt.

These authority values must come from the trusted deployment environment, not
from the publication manifest or a device request. The wrapper supplies the
explicit confirmation flag and invokes the `release-admin` Compose profile. Its
one-shot container mounts the repository read-only, reaches Postgres only over
an internal network, and uses a publisher-only database role. The command
rechecks the repository, artifacts, and evidence, atomically publishes, and
prints the immutable receipt. It never receives gateway/device credentials,
creates fake seed data, or silently advances stable.

The source path is ready for a Docker-host smoke. No production publication has
occurred from this candidate.

See
`reference/openspec/changes/persistent-release-control-plane` for the product
model and staged implementation plan.
