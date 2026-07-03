FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js schema.sql agent-launcher-profiles.json ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
COPY agent-workflows ./agent-workflows
COPY deploy ./deploy

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--env-file-if-exists=.env", "server.js"]
