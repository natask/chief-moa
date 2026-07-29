#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((all, value, index, input) => {
  if (value.startsWith('--')) all.push([value.slice(2), input[index + 1]]);
  return all;
}, []));
for (const name of ['root','repo','apk','test-apk','apksigner','adb','serial','image','preview']) {
  if (!args[name]) throw new Error(`missing --${name}`);
}
const root = resolve(args.root);
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const output = (cmd, argv) => execFileSync(cmd, argv, { encoding: 'utf8' }).trim();
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? walk(path) : [path];
});
const signerOutput = output(args.apksigner, ['verify', '--print-certs', args.apk]);
const signer = signerOutput.match(/Signer #1 certificate SHA-256 digest: ([0-9a-f]+)/i)?.[1];
if (!signer) throw new Error('unable to resolve APK signer SHA-256');
const artifacts = walk(root)
  .filter(path => !path.endsWith('evidence-manifest.json'))
  .map(path => ({ path: relative(root, path), bytes: statSync(path).size, sha256: sha(path) }))
  .sort((a, b) => a.path.localeCompare(b.path));
const manifest = {
  schema: 'moa.android.emulator-evidence.v1',
  result: 'emulator_smoked',
  source_commit: output('git', ['-C', args.repo, 'rev-parse', 'HEAD']),
  application_apk: { path: relative(root, resolve(args.apk)), sha256: sha(args.apk), signer_sha256: signer },
  test_apk: { path: relative(root, resolve(args['test-apk'])), sha256: sha(args['test-apk']) },
  preview_namespace: args.preview,
  scenario: { id: 'transcript-overlay', revision: 'v1', checkpoints: ['partial','final','expanded','copy','history'] },
  environment: {
    serial: args.serial,
    system_image: args.image,
    sdk: output(args.adb, ['-s', args.serial, 'shell', 'getprop', 'ro.build.version.sdk']).replace(/\r/g, ''),
    fingerprint: output(args.adb, ['-s', args.serial, 'shell', 'getprop', 'ro.build.fingerprint']).replace(/\r/g, ''),
    model: output(args.adb, ['-s', args.serial, 'shell', 'getprop', 'ro.product.model']).replace(/\r/g, ''),
  },
  artifacts,
};
writeFileSync(join(root, 'evidence-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
