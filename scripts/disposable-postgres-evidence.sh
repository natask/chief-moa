#!/usr/bin/env bash
# Creates a disposable Postgres container only. Never consumes DATABASE_URL and
# never connects to a pre-existing server. Missing Docker is an explicit skip.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  printf '%s\n' "SKIP disposable Postgres: Docker engine unavailable" >&2
  exit 77
fi
name="moa-evidence-${USER:-user}-$$"
port="${MOA_DISPOSABLE_POSTGRES_PORT:-55432}"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=moa-test -e POSTGRES_DB=moa_evidence -p "127.0.0.1:${port}:5432" postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$name" pg_isready -U postgres -d moa_evidence >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$name" pg_isready -U postgres -d moa_evidence >/dev/null
export DATABASE_URL="postgres://postgres:moa-test@127.0.0.1:${port}/moa_evidence"
cd "$ROOT/gateway"
npm run migrate:up
node --test test/integration/*.integration.test.js
dump="$(mktemp -t moa-evidence-dump).sql"
docker exec "$name" pg_dump -U postgres -d moa_evidence > "$dump"
docker exec "$name" createdb -U postgres moa_restore
docker exec -i "$name" psql -U postgres -d moa_restore < "$dump" >/dev/null
docker exec "$name" psql -U postgres -d moa_restore -Atqc "select count(*) from information_schema.tables where table_schema='public'" | grep -Eq '^[1-9][0-9]*$'
rm -f "$dump"
printf '%s\n' "disposable Postgres migration/integration/dump/restore evidence passed"
