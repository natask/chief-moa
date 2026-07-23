"use strict";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("rendered publisher compose job is one-shot, private, and credential-separated", (t) => {
  const result = spawnSync(
    "docker",
    ["compose", "-f", "docker-compose.yml", "--profile", "release-admin", "config", "--format", "json"],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        POSTGRES_PASSWORD: "test_gateway_database_password",
        RELEASE_CONTROL_POSTGRES_PASSWORD: "test_release_app_password",
        RELEASE_CONTROL_PUBLISHER_POSTGRES_PASSWORD: "test_release_publisher_password",
        MOA_GATEWAY_TOKEN: "test_gateway_token",
        RELEASE_PUBLICATION_MANIFEST: "release/publication.json",
        MOA_REPOSITORY_RELEASE_AUTHORITY_ID: "release_ci",
        MOA_REPOSITORY_RELEASE_GIT_SHA: "a".repeat(40),
        MOA_REPOSITORY_RELEASE_SOURCE_REF: "refs/heads/candidate",
        MOA_REPOSITORY_RELEASE_CHANNELS: "preview",
      },
    },
  );
  if (result.error?.code === "ENOENT") {
    t.skip("docker compose is unavailable");
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  const publisher = config.services["release-publisher"];
  const gateway = config.services.gateway;
  assert.ok(publisher);
  assert.deepEqual(publisher.profiles, ["release-admin"]);
  assert.equal(publisher.restart, "no");
  assert.equal(publisher.read_only, true);
  assert.deepEqual(publisher.cap_drop, ["ALL"]);
  assert.equal(publisher.ports, undefined);
  assert.equal(publisher.environment.DATABASE_URL, undefined);
  assert.equal(publisher.environment.MOA_GATEWAY_TOKEN, undefined);
  assert.match(
    publisher.environment.RELEASE_CONTROL_DATABASE_URL,
    /^postgres:\/\/moa_release_publisher:[^@]+@postgres:5432\/moa_release_control$/,
  );
  assert.deepEqual(Object.keys(publisher.networks), ["release-publisher-db"]);
  assert.equal(config.networks["release-publisher-db"].internal, true);
  assert.equal(gateway.environment.RELEASE_CONTROL_PUBLISHER_POSTGRES_PASSWORD, undefined);
  assert.equal(gateway.environment.MOA_REPOSITORY_RELEASE_AUTHORITY_ID, undefined);
  assert.equal(gateway.environment.MOA_REPOSITORY_RELEASE_GIT_SHA, undefined);
  assert.equal(gateway.environment.MOA_REPOSITORY_RELEASE_SOURCE_REF, undefined);
  assert.equal(gateway.environment.MOA_REPOSITORY_RELEASE_CHANNELS, undefined);
  const command = Array.isArray(publisher.command) ? publisher.command.join(" ") : String(publisher.command);
  assert.match(command, /publish-manifest/);
  assert.match(command, /--confirm-publish-exact-release/);
});
