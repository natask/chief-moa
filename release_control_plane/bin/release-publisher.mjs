#!/usr/bin/env node
"use strict";

import { readFileSync } from "node:fs";
import path from "node:path";
import { evaluateReleaseEvidence } from "../../scripts/release/release-evidence.mjs";
import { Pool } from "pg";
import { createPostgresReleaseAdapter } from "../lib/postgres-adapter.mjs";
import {
  dedicatedReleaseDatabaseUrl,
  parsePublicationCommand,
  repositoryAuthorityFromEnvironment,
} from "../lib/publication-command.mjs";
import { createReleaseBundlePublisher } from "../lib/publisher.mjs";
import { normalizePublicationManifest } from "../lib/publisher.mjs";
import { createLocalRepositoryPublicationInputs } from "../lib/repository-inputs.mjs";

async function main(argv) {
  let parsedCommand;
  try {
    parsedCommand = parsePublicationCommand(argv);
  } catch (error) {
    console.error("usage: release-publisher.mjs check-manifest <publication-manifest.json>");
    console.error("   or: release-publisher.mjs publish-manifest <publication-manifest.json> --confirm-publish-exact-release");
    return 2;
  }
  const { command, manifest_path: manifestPath } = parsedCommand;
  try {
    const manifest = normalizePublicationManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    const inputs = createLocalRepositoryPublicationInputs({ repository_root: process.cwd() });
    if (command === "publish-manifest") {
      const authority = repositoryAuthorityFromEnvironment(process.env, manifest);
      const pool = new Pool({
        connectionString: dedicatedReleaseDatabaseUrl(process.env),
        max: 1,
        connectionTimeoutMillis: 10_000,
        application_name: "chief-moa-release-publisher",
      });
      try {
        const publisher = createReleaseBundlePublisher({
          adapter: createPostgresReleaseAdapter(pool),
          authorizePublication: async () => authority,
          inspectSource: inputs.inspectSource,
          inspectArtifact: inputs.inspectArtifact,
          loadEvidence: inputs.loadEvidence,
          loadPromotionEvidence: inputs.loadEvidenceWithDigest,
          evaluateEvidence: evaluateReleaseEvidence,
        });
        const publication = await publisher.publish(manifest, {
          command: "publish-manifest",
          authority_source: "trusted_deployment_environment",
        });
        process.stdout.write(`${JSON.stringify({
          ok: true,
          publication_performed: true,
          bundle_id: publication.bundle.bundle_id,
          channel: publication.head.channel,
          sequence: publication.head.sequence,
          receipt: publication.receipt,
        }, null, 2)}\n`);
        return 0;
      } finally {
        await pool.end();
      }
    }
    const source = await inputs.inspectSource({
      source_ref: manifest.source_ref,
      git_sha: manifest.git_sha,
      tracked_paths: manifest.tracked_paths,
    });
    const artifacts = [];
    for (const artifact of manifest.artifacts) {
      const observed = await inputs.inspectArtifact(artifact.artifact_ref);
      const evidence = evaluateReleaseEvidence(await inputs.loadEvidence(artifact.evidence_ref));
      artifacts.push({
        surface_id: artifact.surface_id,
        release_id: artifact.release_id,
        artifact_sha256: artifact.artifact_sha256,
        artifact_size: artifact.artifact_size,
        bytes_match: observed.sha256 === artifact.artifact_sha256
          && observed.size_bytes === artifact.artifact_size,
        evidence_matches: evidence.ok === true
          && evidence.surface === artifact.surface_id
          && evidence.release_id === artifact.release_id
          && evidence.artifact_sha256 === artifact.artifact_sha256
          && evidence.channel === manifest.channel,
        publication_ready: evidence.publication_ready === true
          && evidence.channel_advance_allowed === true,
      });
    }
    const eligible = source.commit_exists === true
      && source.ref_git_sha === manifest.git_sha
      && source.tracked_paths_clean === true
      && artifacts.every((artifact) => artifact.bytes_match
        && artifact.evidence_matches
        && artifact.publication_ready);
    process.stdout.write(`${JSON.stringify({
      ok: eligible,
      version: manifest.version,
      tenant_id: manifest.tenant_id,
      application_id: manifest.application_id,
      bundle_id: manifest.bundle_id,
      channel: manifest.channel,
      git_sha: manifest.git_sha,
      repository_root: path.resolve(process.cwd()),
      source,
      artifact_bindings: artifacts,
      publication_performed: false,
    }, null, 2)}\n`);
    return eligible ? 0 : 1;
  } catch (error) {
    console.error(`release publication failed: ${error.message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
