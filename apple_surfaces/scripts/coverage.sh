#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

threshold="${APPLE_COVERAGE_THRESHOLD:-90}"
report_only=false
if [[ "${1:-}" == "--report-only" ]]; then
  report_only=true
elif [[ $# -gt 0 ]]; then
  echo "usage: $0 [--report-only]" >&2
  exit 2
fi

swift test --enable-code-coverage
swift build --enable-code-coverage --product AggieSurfaceApp
swift build --enable-code-coverage --product Ag

architecture="$(swift -print-target-info | sed -n 's/.*"triple": "\([^-]*\)-.*/\1/p' | head -1)"
build_dir=".build/${architecture}-apple-macosx/debug"
test_binary="${build_dir}/AggieAppleSurfacePackageTests.xctest/Contents/MacOS/AggieAppleSurfacePackageTests"
profile="${build_dir}/codecov/default.profdata"
combined_profile="${build_dir}/codecov/apple-combined.profdata"
report="${build_dir}/apple-production-coverage.txt"

rm -f "${build_dir}/codecov/aggie-app.profraw" "${build_dir}/codecov/ag-mac.profraw"
LLVM_PROFILE_FILE="${build_dir}/codecov/aggie-app.profraw" "${build_dir}/AggieSurfaceApp" --coverage-smoke
LLVM_PROFILE_FILE="${build_dir}/codecov/ag-mac.profraw" "${build_dir}/Ag" --coverage-smoke
xcrun llvm-profdata merge -sparse "$profile" \
  "${build_dir}/codecov/aggie-app.profraw" "${build_dir}/codecov/ag-mac.profraw" \
  -o "$combined_profile"

objects=(
  "$test_binary"
  -object "${build_dir}/AggieSurfaceApp"
  -object "${build_dir}/Ag"
)

xcrun llvm-cov report "${objects[@]}" -instr-profile "$combined_profile" \
  -ignore-filename-regex='Tests/|\.build/|AggieSurfaceUI/|MoaMacUI/' | tee "$report"

scope_sources="$(mktemp)"
report_sources="$(mktemp)"
owned_files="$(mktemp)"
trap 'rm -f "$scope_sources" "$report_sources" "$owned_files"' EXIT

awk '$1 == "executable" { print $2 }' coverage-scope.txt | sort > "$scope_sources"
git ls-files --cached --others --exclude-standard -- . | sort > "$owned_files"
while IFS= read -r source; do
  matches="$(awk -v source="$source" '$2 == source { count += 1 } END { print count + 0 }' coverage-scope.txt)"
  if [[ "$matches" -ne 1 ]]; then
    echo "coverage scope error: $source is classified $matches times" >&2
    exit 1
  fi
done < "$owned_files"
awk 'NF == 2 && $1 !~ /^#/ { print $2 }' coverage-scope.txt | sort | while IFS= read -r classified; do
  if ! grep -Fxq "$classified" "$owned_files"; then
    echo "coverage scope error: classified file does not exist: $classified" >&2
    exit 1
  fi
done

awk '$1 ~ /\.swift$/ { print "Sources/" $1 }' "$report" | sort -u > "$report_sources"
while IFS= read -r source; do
  short="${source#Sources/}"
  if ! grep -Fq "$short" "$report"; then
    echo "coverage scope error: executable source missing from LLVM report: $source" >&2
    exit 1
  fi
done < "$scope_sources"

totals="$(awk '$1 == "TOTAL" { gsub("%", "", $7); gsub("%", "", $10); gsub("%", "", $13); print $7, $10, $13 }' "$report")"
read -r function_percent line_percent branch_percent <<< "$totals"

if [[ -z "$function_percent" || -z "$line_percent" ]]; then
  echo "coverage gate error: could not parse LLVM totals" >&2
  exit 1
fi

region_percent="$(awk '$1 == "TOTAL" { gsub("%", "", $4); print $4 }' "$report")"
echo "Apple executable coverage: lines=${line_percent}% functions=${function_percent}% regions=${region_percent}% branches=${branch_percent:--}"

if $report_only; then
  exit 0
fi

failed=false
for metric in lines functions regions; do
  case "$metric" in
    lines) value="$line_percent" ;;
    functions) value="$function_percent" ;;
    regions) value="$region_percent" ;;
  esac
  if ! awk -v value="$value" -v threshold="$threshold" 'BEGIN { exit !(value + 0 >= threshold + 0) }'; then
    echo "coverage gate failed: $metric ${value}% is below ${threshold}%" >&2
    failed=true
  fi
done

if [[ -z "$branch_percent" || "$branch_percent" == "-" ]]; then
  echo "coverage gate failed: this Swift/LLVM toolchain emitted no branch counter; regions are reported but are not relabeled as branches" >&2
  failed=true
elif ! awk -v value="$branch_percent" -v threshold="$threshold" 'BEGIN { exit !(value + 0 >= threshold + 0) }'; then
  echo "coverage gate failed: branches ${branch_percent}% is below ${threshold}%" >&2
  failed=true
fi

$failed && exit 1
echo "Apple production coverage gate passed at ${threshold}% for lines, branches, and functions"
