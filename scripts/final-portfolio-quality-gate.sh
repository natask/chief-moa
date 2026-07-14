#!/usr/bin/env bash
# Reproducible whole-portfolio source gate. Every discovered test in the
# gateway/Swift/Rust packages runs; focused quality gates supplement rather
# than replace those complete package suites.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/gateway"
npm test
npm run check:context-quality
npm run quality:aggie-protocol
npm run test:billing
npm run test:companion-package
node --test test/work-history-deployment-control.test.js

cd "$ROOT/apple_surfaces"
swift test

cd "$ROOT/windows_app/core"
cargo test --locked
cargo clippy --all-targets -- -D warnings

printf '%s\n' "final portfolio quality gate passed"
