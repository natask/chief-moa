#!/usr/bin/env bash
set -euo pipefail

PREVIEW_PORT="${MOA_PREVIEW_PORT:-8791}"
PREVIEW_ROOT="${MOA_PREVIEW_ROOT:-/private/tmp/chief-moa-gateway-preview-${PREVIEW_PORT}}"
PREVIEW_DATA_DIR="${PREVIEW_ROOT}/data"
PREVIEW_PID_FILE="${PREVIEW_ROOT}/gateway.pid"
PREVIEW_TOKEN_FILE="${PREVIEW_ROOT}/gateway.token"
PREVIEW_LOG_FILE="${PREVIEW_ROOT}/gateway.log"
PREVIEW_NODE_FILE="${PREVIEW_ROOT}/node.path"
PREVIEW_BUILD_SHA_FILE="${PREVIEW_ROOT}/build.sha"
PREVIEW_BUILD_REF_FILE="${PREVIEW_ROOT}/build.ref"
PREVIEW_BUILD_TIME_FILE="${PREVIEW_ROOT}/build.time"
PREVIEW_PROJECT="${MOA_PREVIEW_GCP_PROJECT:-deploy-465618}"
PREVIEW_LABEL="app.agee.gateway-preview-${PREVIEW_PORT}"
PREVIEW_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREVIEW_GATEWAY_DIR="${PREVIEW_REPO_ROOT}/gateway"
PREVIEW_SCRIPT_PATH="${PREVIEW_REPO_ROOT}/scripts/preview/gateway-lan.sh"
PREVIEW_LOOPBACK_URL="http://127.0.0.1:${PREVIEW_PORT}"

usage() {
  echo "Usage: $0 {start|status|smoke|stop}"
}

launch_service_exists() {
  launchctl print "gui/$(id -u)/${PREVIEW_LABEL}" >/dev/null 2>&1
}

running_pid() {
  if ! launch_service_exists; then
    return 1
  fi
  local preview_pid
  preview_pid="$(launchctl print "gui/$(id -u)/${PREVIEW_LABEL}" 2>/dev/null | awk '/^[[:space:]]*pid = / { print $3; exit }')"
  if [[ ! "${preview_pid}" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  printf '%s\n' "${preview_pid}"
}

reachable_urls() {
  echo "Loopback URL: ${PREVIEW_LOOPBACK_URL}"

  local lan_ip=""
  if command -v ipconfig >/dev/null 2>&1; then
    lan_ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
    if [[ -z "${lan_ip}" ]]; then
      lan_ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
    fi
  fi
  if [[ -n "${lan_ip}" ]]; then
    echo "LAN URL: http://${lan_ip}:${PREVIEW_PORT}"
  fi

  local tailscale_ip=""
  if command -v tailscale >/dev/null 2>&1; then
    tailscale_ip="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
  fi
  if [[ -n "${tailscale_ip}" ]]; then
    echo "Tailscale URL: http://${tailscale_ip}:${PREVIEW_PORT}"
  fi
}

show_paths() {
  echo "Token file (value not shown): ${PREVIEW_TOKEN_FILE}"
  echo "Data directory: ${PREVIEW_DATA_DIR}"
  echo "Log file: ${PREVIEW_LOG_FILE}"
}

seed_preview_profile() {
  if [[ -f "${PREVIEW_DATA_DIR}/agent-profile.json" ]]; then
    return 0
  fi
  local preview_token
  preview_token="$(tr -d '[:space:]' < "${PREVIEW_TOKEN_FILE}")"
  curl --silent --show-error --fail --max-time 10 \
    --request PUT \
    --header "Authorization: Bearer ${preview_token}" \
    --header "Content-Type: application/json" \
    --data '{"profile":{"input_languages":"en-US,am-ET","input_language_primary":"en-US"},"source":"gateway-lan-preview-bootstrap"}' \
    --output "${PREVIEW_ROOT}/initial-profile.json" \
    "${PREVIEW_LOOPBACK_URL}/v1/agent/profile"
}

start_preview() {
  local preview_pid=""
  if preview_pid="$(running_pid)"; then
    seed_preview_profile
    echo "Gateway preview is already running (pid ${preview_pid})."
    reachable_urls
    show_paths
    return 0
  fi
  if launch_service_exists; then
    launchctl remove "${PREVIEW_LABEL}"
  fi

  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"${PREVIEW_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port ${PREVIEW_PORT} is already occupied by another process." >&2
    return 1
  fi
  if ! command -v gcloud >/dev/null 2>&1; then
    echo "gcloud is required for the real-provider ADC preview." >&2
    return 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required to run the gateway preview." >&2
    return 1
  fi
  if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
    echo "Application Default Credentials are unavailable. Run: gcloud auth application-default login" >&2
    return 1
  fi

  umask 077
  mkdir -p "${PREVIEW_DATA_DIR}"
  openssl rand -hex 32 > "${PREVIEW_TOKEN_FILE}.next"
  mv "${PREVIEW_TOKEN_FILE}.next" "${PREVIEW_TOKEN_FILE}"
  command -v node > "${PREVIEW_NODE_FILE}"
  git -C "${PREVIEW_REPO_ROOT}" rev-parse HEAD > "${PREVIEW_BUILD_SHA_FILE}"
  git -C "${PREVIEW_REPO_ROOT}" symbolic-ref --short HEAD > "${PREVIEW_BUILD_REF_FILE}"
  date -u +%Y-%m-%dT%H:%M:%SZ > "${PREVIEW_BUILD_TIME_FILE}"
  : > "${PREVIEW_LOG_FILE}"

  launchctl submit \
    -l "${PREVIEW_LABEL}" \
    -o "${PREVIEW_LOG_FILE}" \
    -e "${PREVIEW_LOG_FILE}" \
    -- "${PREVIEW_SCRIPT_PATH}" run

  local _attempt
  for _attempt in {1..40}; do
    if curl --silent --fail --max-time 2 "${PREVIEW_LOOPBACK_URL}/health" >/dev/null 2>&1; then
      seed_preview_profile
      echo "Gateway preview started."
      reachable_urls
      show_paths
      return 0
    fi
    if ! running_pid >/dev/null; then
      echo "Gateway preview exited during startup. Inspect ${PREVIEW_LOG_FILE}." >&2
      return 1
    fi
    sleep 0.25
  done

  echo "Gateway preview did not become healthy. Inspect ${PREVIEW_LOG_FILE}." >&2
  return 1
}

status_preview() {
  local preview_pid=""
  if ! preview_pid="$(running_pid)"; then
    echo "Gateway preview is not running."
    show_paths
    return 1
  fi
  echo "Gateway preview is running (pid ${preview_pid})."
  reachable_urls
  show_paths
  if ! curl --silent --show-error --fail --max-time 5 "${PREVIEW_LOOPBACK_URL}/health"; then
    echo "Gateway launch service exists, but its health endpoint is unreachable." >&2
    return 1
  fi
  echo
}

smoke_preview() {
  if ! running_pid >/dev/null; then
    echo "Gateway preview is not running." >&2
    return 1
  fi
  if [[ ! -s "${PREVIEW_TOKEN_FILE}" ]]; then
    echo "Gateway preview token file is missing." >&2
    return 1
  fi

  local preview_token
  preview_token="$(tr -d '[:space:]' < "${PREVIEW_TOKEN_FILE}")"
  curl --silent --show-error --fail --max-time 5 "${PREVIEW_LOOPBACK_URL}/health" >/dev/null

  local unauth_status
  unauth_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
    "${PREVIEW_LOOPBACK_URL}/v1/sessions/preview-auth-check/messages")"
  if [[ "${unauth_status}" != "401" ]]; then
    echo "Expected unauthenticated protected route to return 401; got ${unauth_status}." >&2
    return 1
  fi

  local smoke_body
  smoke_body='{"session_id":"gateway-lan-preview-smoke","conversation_id":"gateway-lan-preview-smoke","source":"gateway-lan-preview","messages":[{"role":"user","content":"Reply with exactly: preview ready"}]}'
  local response_file="${PREVIEW_ROOT}/last-model-smoke.json"
  curl --silent --show-error --fail --max-time 60 \
    --request POST \
    --header "Authorization: Bearer ${preview_token}" \
    --header "Content-Type: application/json" \
    --data "${smoke_body}" \
    --output "${response_file}" \
    "${PREVIEW_LOOPBACK_URL}/v1/chat"

  if ! node -e '
    const fs = require("fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const marker = String(body.text || "").trim().toLowerCase();
    if (!/^preview ready(?:[^a-z0-9].*)?$/.test(marker)) process.exit(1);
  ' "${response_file}"; then
    echo "Real-provider smoke returned JSON but not the requested marker. Inspect ${response_file}." >&2
    return 1
  fi
  echo "Smoke passed: health, token enforcement, and one real Vertex model turn."
  echo "Smoke response file: ${response_file}"
}

stop_preview() {
  local preview_pid=""
  if ! preview_pid="$(running_pid)"; then
    echo "Gateway preview is not running."
    return 0
  fi
  launchctl remove "${PREVIEW_LABEL}"
  local _attempt
  for _attempt in {1..40}; do
    if ! launch_service_exists; then
      : > "${PREVIEW_PID_FILE}"
      echo "Gateway preview stopped."
      return 0
    fi
    sleep 0.25
  done
  echo "Gateway preview did not stop after SIGTERM (pid ${preview_pid})." >&2
  return 1
}

run_preview() {
  if [[ ! -s "${PREVIEW_TOKEN_FILE}" ]]; then
    echo "Gateway preview token file is missing." >&2
    return 1
  fi
  if [[ ! -s "${PREVIEW_NODE_FILE}" ]]; then
    echo "Gateway preview node path is missing." >&2
    return 1
  fi
  if [[ ! -s "${PREVIEW_BUILD_SHA_FILE}" || ! -s "${PREVIEW_BUILD_REF_FILE}" || ! -s "${PREVIEW_BUILD_TIME_FILE}" ]]; then
    echo "Gateway preview build identity is missing." >&2
    return 1
  fi
  local preview_token
  local preview_node
  local preview_build_sha
  local preview_build_ref
  local preview_build_time
  preview_token="$(tr -d '[:space:]' < "${PREVIEW_TOKEN_FILE}")"
  preview_node="$(tr -d '[:space:]' < "${PREVIEW_NODE_FILE}")"
  preview_build_sha="$(tr -d '[:space:]' < "${PREVIEW_BUILD_SHA_FILE}")"
  preview_build_ref="$(tr -d '[:space:]' < "${PREVIEW_BUILD_REF_FILE}")"
  preview_build_time="$(tr -d '[:space:]' < "${PREVIEW_BUILD_TIME_FILE}")"
  cd "${PREVIEW_GATEWAY_DIR}"
  exec env \
    MOA_MODE=local \
    HOST=0.0.0.0 \
    PORT="${PREVIEW_PORT}" \
    DATA_DIR="${PREVIEW_DATA_DIR}" \
    ANDROID_OTA_DIR="${PREVIEW_DATA_DIR}/android-ota" \
    MOA_GATEWAY_TOKEN="${preview_token}" \
    MOA_BUILD_SHA="${preview_build_sha}" \
    MOA_BUILD_REF="${preview_build_ref}" \
    MOA_BUILD_TIME="${preview_build_time}" \
    MODEL_PROVIDER=vertex \
    MODEL_ID=gemini-3.5-flash \
    VERTEX_API_VERSION=v1beta1 \
    VERTEX_PROJECT="${PREVIEW_PROJECT}" \
    VERTEX_LOCATION=global \
    GOOGLE_CLOUD_PROJECT="${PREVIEW_PROJECT}" \
    GOOGLE_CLOUD_LOCATION=global \
    GCP_PROJECT_ID="${PREVIEW_PROJECT}" \
    GCP_LOCATION=us \
    VOICE_PROVIDER=chirp \
    VOICE_STT_PROVIDER=chirp \
    VOICE_REASONING_PROVIDER=gateway \
    VOICE_LLM_PROVIDER=vertex \
    VOICE_TTS_PROVIDER=cloud-tts \
    CHIRP_MODEL=chirp_3 \
    CHIRP_PROMPT_LANGUAGE_CODES=en-US,am-ET \
    MOA_PET_ENABLE_VERTEX_GENERATION=0 \
    "${preview_node}" server.js
}

case "${1:-}" in
  start) start_preview ;;
  status) status_preview ;;
  smoke) smoke_preview ;;
  stop) stop_preview ;;
  run) run_preview ;;
  *) usage; exit 2 ;;
esac
