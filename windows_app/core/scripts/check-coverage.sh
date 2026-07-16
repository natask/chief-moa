#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! cargo llvm-cov --version >/dev/null 2>&1; then
  echo "cargo-llvm-cov is required; install it with: cargo install cargo-llvm-cov --locked" >&2
  exit 1
fi

cargo llvm-cov clean --workspace
report="$({
  cargo llvm-cov \
    --locked \
    --workspace \
    --all-features \
    --branch \
    --ignore-filename-regex 'src/tests\.rs$' \
    --summary-only
} 2>&1)"
printf '%s\n' "$report"

total_line="$(printf '%s\n' "$report" | awk '$1 == "TOTAL" { print; exit }')"
if [[ -z "$total_line" ]]; then
  echo "coverage gate failed: TOTAL row was not produced" >&2
  exit 1
fi

read -r functions lines branches < <(
  printf '%s\n' "$total_line" |
    awk '{ gsub(/%/, ""); print $7, $10, $13 }'
)

for metric in functions lines branches; do
  value="${!metric}"
  if ! awk -v value="$value" 'BEGIN { exit !(value + 0 >= 90) }'; then
    echo "coverage gate failed: $metric coverage is ${value}% (minimum 90%)" >&2
    exit 1
  fi
done

echo "coverage gate passed: lines=${lines}% functions=${functions}% branches=${branches}%"
