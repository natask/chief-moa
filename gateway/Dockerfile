# syntax=docker/dockerfile:1
#
# One deployable gateway image. Deployment mode is env config (MOA_MODE), not a
# build variant: the same image runs local dev, self-host BYOK, and hosted.
# Never bake provider keys, tokens, or harness credentials into this image; the
# gateway does not run agent harnesses in remote modes (worker-pull owns that).

FROM node:22-bookworm-slim AS runtime

ARG MOA_BUILD_SHA=unknown
ARG MOA_BUILD_REF=unknown
ARG MOA_BUILD_TIME=unknown

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    ANDROID_OTA_DIR=/srv/android-ota \
    ANDROID_OTA_LEGACY_DIR=/data/android-ota \
    MOA_BUILD_SHA=$MOA_BUILD_SHA \
    MOA_BUILD_REF=$MOA_BUILD_REF \
    MOA_BUILD_TIME=$MOA_BUILD_TIME

WORKDIR /app

# One dependency truth: the committed pnpm-lock.yaml drives dev, CI verify,
# and this image identically. corepack pins pnpm from package.json's
# packageManager field. package-lock.json remains in-repo only as the npm-ci
# rollback path for this switch.
COPY gateway/package.json gateway/pnpm-lock.yaml ./
RUN corepack enable \
  && corepack prepare --activate \
  && pnpm install --frozen-lockfile --prod \
  && pnpm store prune

COPY gateway/server.js gateway/auth.mjs gateway/schema.sql gateway/agent-launcher-profiles.json ./
COPY gateway/lib ./lib
COPY gateway/migrations ./migrations
COPY gateway/public ./public
COPY gateway/scripts ./scripts
COPY gateway/agent-workflows ./agent-workflows
# Release control is a separately persisted authority, but it is hosted by this
# runtime. Copy its reviewed library and additive migration; never bake release
# records, credentials, or mutable database state into the image.
COPY release_control_plane ./release_control_plane

# Create and own both OTA locations. The mount point must exist and belong to
# the gateway user before the volume is attached, so a fresh volume inherits
# uid 1000 instead of root -- root ownership here is exactly what crash-looped
# production on 2026-07-29.
RUN mkdir -p /data/android-ota /srv/android-ota \
  && chown -R node:node /app /data /srv/android-ota

USER node

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const port = process.env.PORT || '8787'; fetch('http://127.0.0.1:' + port + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));"

CMD ["node", "--env-file-if-exists=.env", "server.js"]
