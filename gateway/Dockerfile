# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    ANDROID_OTA_DIR=/data/android-ota

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js schema.sql agent-launcher-profiles.json ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
COPY agent-workflows ./agent-workflows

RUN mkdir -p /data/android-ota \
  && chown -R node:node /app /data

USER node

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const port = process.env.PORT || '8787'; fetch('http://127.0.0.1:' + port + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));"

CMD ["node", "--env-file-if-exists=.env", "server.js"]
