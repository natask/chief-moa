#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
compose="$root/docker-compose.yml"
promotion="$root/scripts/vps/promote-candidate.sh"
runtime="$root/scripts/vps/lib.sh"

# The active and isolated preview gateways receive server-only coordinator
# authority. Promotion evidence callers and their fallback Node container do
# not receive it.
grep -q 'MOA_DEVELOPMENT_COORDINATOR_TOKEN: ${MOA_DEVELOPMENT_COORDINATOR_TOKEN:-}' "$compose"
grep -q 'install-promotion-control-plane.sh" --install' "$promotion"
grep -q '^preview_coordinator_token="$(openssl rand -hex 32)"$' "$promotion"
grep -q '^MOA_DEVELOPMENT_COORDINATOR_TOKEN=$preview_coordinator_token$' "$promotion"
if grep -q -- '-e MOA_DEVELOPMENT_COORDINATOR_TOKEN' "$runtime"; then
  echo "coordinator credential leaked into generic promotion callers" >&2
  exit 1
fi

echo "development coordinator credential routing test passed"
