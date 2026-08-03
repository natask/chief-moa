"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("production image contains the Better Auth runtime and additive migrations", () => {
  const dockerfile = read("gateway/Dockerfile");
  assert.match(dockerfile, /COPY gateway\/server\.js gateway\/auth\.mjs gateway\/schema\.sql/);
  assert.match(dockerfile, /COPY gateway\/migrations \.\/migrations/);
});

test("compose migrates before boot and passes only declared auth configuration", () => {
  const compose = read("docker-compose.yml");
  assert.match(compose, /gateway-db-init:\n\s+condition: service_completed_successfully/);
  assert.match(compose, /gateway-db-init:\n[\s\S]*node-pg-migrate[\s\S]*--single-transaction/);
  for (const key of [
    "MOA_AUTH", "BETTER_AUTH_URL", "BETTER_AUTH_SECRET",
    "BETTER_AUTH_OWNER_EMAIL", "BETTER_AUTH_TRUSTED_ORIGINS",
  ]) {
    assert.ok(compose.includes(`${key}: ` + "${" + `${key}:-}`));
  }
});

test("isolated VPS preview proves the device bearer and voice-ticket path", () => {
  const promotion = read("scripts/vps/promote-candidate.sh");
  const smoke = read("gateway/scripts/smoke-better-auth-device.js");
  assert.match(promotion, /MOA_AUTH=better-auth/);
  assert.match(promotion, /smoke-better-auth-device\.js/);
  assert.match(promotion, /NODE_TLS_REJECT_UNAUTHORIZED=0/);
  assert.match(smoke, /const headers = \{ origin,/);
  const updater = read("scripts/vps/update.sh");
  assert.match(updater, /compose run --rm --no-deps gateway-db-init\ncompose up -d --no-deps gateway/);
});
