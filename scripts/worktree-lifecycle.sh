#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/worktree-lifecycle.sh [audit|archive-safe] [--target-ref REF] [--execute]

Commands:
  audit         Classify every registered worktree without changing anything.
  archive-safe  Show clean worktrees whose commits are already contained in, or
                patch-equivalent to, the target ref. Add --execute to record and
                remove only those execution directories.

The primary checkout, the invoking checkout, dirty worktrees, unique commits,
and all branch refs are always preserved. Exact closure records are appended to
the shared Git directory under chief-moa-worktree-archive/closures.tsv.
EOF
}

command_name="audit"
target_ref="origin/master"
execute=false

if [ "$#" -gt 0 ] && [[ "$1" != --* ]]; then
  command_name="$1"
  shift
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-ref)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      target_ref="$2"
      shift 2
      ;;
    --execute)
      execute=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$command_name" in
  audit|archive-safe) ;;
  *)
    printf 'Unknown command: %s\n' "$command_name" >&2
    usage >&2
    exit 2
    ;;
esac

repo_root="$(git rev-parse --show-toplevel)"
common_git_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
primary_checkout="$(dirname "$common_git_dir")"
target_sha="$(git rev-parse --verify "${target_ref}^{commit}")"
archive_dir="$common_git_dir/chief-moa-worktree-archive"
archive_file="$archive_dir/closures.tsv"
invoking_checkout="$repo_root"
active_cwds=""

if command -v lsof >/dev/null 2>&1; then
  active_cwds="$(lsof -a -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true)"
fi

worktree_in_use() {
  local path="$1"
  local cwd

  while IFS= read -r cwd; do
    [ -n "$cwd" ] || continue
    if [ "$cwd" = "$path" ] || [[ "$cwd" == "$path/"* ]]; then
      return 0
    fi
  done <<<"$active_cwds"
  return 1
}

classify_commit() {
  local sha="$1"
  local unique_count

  if git merge-base --is-ancestor "$sha" "$target_sha"; then
    printf 'contained'
    return
  fi

  if unique_count="$(git cherry "$target_sha" "$sha" 2>/dev/null | awk '$1 == "+" { count++ } END { print count + 0 }')" \
    && [ "$unique_count" -eq 0 ]; then
    printf 'patch-equivalent'
    return
  fi

  printf 'unique'
}

record_closure() {
  local path="$1"
  local branch="$2"
  local sha="$3"
  local classification="$4"
  local timestamp

  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$archive_dir"
  if [ ! -f "$archive_file" ]; then
    printf 'closed_at\tpath\tbranch\thead\tclassification\ttarget_ref\ttarget_sha\n' >"$archive_file"
  elif awk -F '\t' \
    -v path="$path" \
    -v sha="$sha" \
    -v classification="$classification" \
    -v target_sha="$target_sha" \
    '$2 == path && $4 == sha && $5 == classification && $7 == target_sha { found = 1 }
     END { exit found ? 0 : 1 }' "$archive_file"; then
    return
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$timestamp" "$path" "$branch" "$sha" "$classification" "$target_ref" "$target_sha" \
    >>"$archive_file"
}

printf 'state\tdirty\tbranch\thead\tpath\n'

prunable_seen=false
while IFS=$'\t' read -r path sha branch prunable; do
  if [ "$prunable" = "yes" ] || [ ! -d "$path" ]; then
    classification="prunable"
    dirty="unknown"
  elif [ "$path" = "$primary_checkout" ] || [ "$path" = "$invoking_checkout" ]; then
    classification="protected"
    dirty="$([ -n "$(git -C "$path" status --porcelain)" ] && printf yes || printf no)"
  elif worktree_in_use "$path"; then
    classification="in-use"
    dirty="$([ -n "$(git -C "$path" status --porcelain)" ] && printf yes || printf no)"
  else
    dirty="$([ -n "$(git -C "$path" status --porcelain)" ] && printf yes || printf no)"
    if [ "$dirty" = "yes" ]; then
      classification="dirty"
    else
      classification="$(classify_commit "$sha")"
    fi
  fi

  if [ "$command_name" = "audit" ] \
    || [ "$classification" = "contained" ] \
    || [ "$classification" = "patch-equivalent" ] \
    || [ "$classification" = "prunable" ]; then
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "$classification" "$dirty" "$branch" "${sha:0:12}" "$path"
  fi

  if [ "$command_name" != "archive-safe" ] || [ "$execute" != true ]; then
    continue
  fi

  case "$classification" in
    contained|patch-equivalent)
      record_closure "$path" "$branch" "$sha" "$classification"
      git worktree remove "$path"
      ;;
    prunable)
      record_closure "$path" "$branch" "$sha" "$classification"
      prunable_seen=true
      ;;
  esac
done < <(
  git worktree list --porcelain | awk '
    /^worktree / {
      if (path != "") print path "\t" head "\t" branch "\t" prunable
      path = substr($0, 10)
      head = ""
      branch = "detached"
      prunable = "no"
    }
    /^HEAD / { head = $2 }
    /^branch / { branch = substr($0, 8) }
    /^prunable / { prunable = "yes" }
    END {
      if (path != "") print path "\t" head "\t" branch "\t" prunable
    }
  '
)

if [ "$command_name" = "archive-safe" ] && [ "$execute" = true ] && [ "$prunable_seen" = true ]; then
  git worktree prune
fi

if [ "$command_name" = "archive-safe" ] && [ "$execute" != true ]; then
  printf '\nDry run only. Re-run with --execute to archive and remove the listed safe worktrees.\n' >&2
fi

if [ "$command_name" = "archive-safe" ] && [ "$execute" = true ]; then
  printf '\nClosure ledger: %s\n' "$archive_file" >&2
fi
