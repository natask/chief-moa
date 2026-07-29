#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const manifestPath = resolve(process.argv[2] || '');
if (!existsSync(manifestPath)) throw new Error(`manifest missing: ${manifestPath}`);
const root = dirname(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const fail = message => { throw new Error(`invalid emulator evidence: ${message}`); };
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
if (manifest.schema !== 'moa.android.emulator-evidence.v1') fail('unsupported schema');
if (manifest.result !== 'emulator_smoked') fail('result is not emulator_smoked');
if (!/^[0-9a-f]{40}$/.test(manifest.source_commit || '')) fail('source commit must be full SHA');
if (!/^[0-9a-f]{64}$/.test(manifest.application_apk?.signer_sha256 || '')) fail('APK signer missing');
if (!manifest.preview_namespace) fail('preview namespace missing');
if (manifest.scenario?.id !== 'transcript-overlay' || !manifest.scenario?.revision) fail('scenario identity missing');
const checkpoints = ['partial','final','expanded','copy','history'];
for (const checkpoint of checkpoints) {
  for (const suffix of ['png','xml']) {
    if (!manifest.artifacts.some(item => item.path === `device/${checkpoint}.${suffix}`)) fail(`checkpoint missing: ${checkpoint}.${suffix}`);
  }
}
for (const required of ['device/interaction-trace.txt','device/logcat.txt','device/screenrecord.mp4','apks/application.apk','apks/test.apk']) {
  if (!manifest.artifacts.some(item => item.path === required)) fail(`required artifact missing: ${required}`);
}
if (!manifest.artifacts.some(item => item.path === 'device/junit.xml')) fail('JUnit XML evidence missing');
const junit = readFileSync(resolve(root, 'device/junit.xml'), 'utf8');
if (!/<testsuite\b/.test(junit) || !/failures="0"/.test(junit) || !/errors="0"/.test(junit)) fail('JUnit does not prove a passing scenario');
for (const item of manifest.artifacts) {
  const path = resolve(root, item.path);
  if (!path.startsWith(`${root}/`) || !existsSync(path)) fail(`artifact unavailable: ${item.path}`);
  if (statSync(path).size !== item.bytes) fail(`size changed: ${item.path}`);
  if (sha(path) !== item.sha256) fail(`digest changed: ${item.path}`);
}
for (const key of ['application_apk','test_apk']) {
  const record = manifest[key];
  const path = resolve(root, record.path);
  if (sha(path) !== record.sha256) fail(`${key} identity differs`);
}
console.log(`verified emulator_smoked ${manifest.application_apk.sha256}`);
