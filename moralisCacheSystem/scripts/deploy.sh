#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(git -C "${SERVICE_DIR}" rev-parse --show-toplevel 2>/dev/null || printf '%s' "${SERVICE_DIR}")"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DEPLOY_REF="${DEPLOY_REF:-main}"
GIT_UPDATE="${GIT_UPDATE:-true}"
HEALTH_URL="${HEALTH_URL:-}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-90}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

validate_env() {
  cd "${SERVICE_DIR}"

  if [[ ! -f .env ]]; then
    echo "Missing .env in ${SERVICE_DIR}. Copy .env.production.example or run scripts/bootstrap-server.sh." >&2
    exit 2
  fi

  if grep -Eq 'replace-with|your-key|change-me|PUT_MORALIS_API_KEY_HERE' .env; then
    echo ".env contains placeholder secrets. Set MORALIS_API_KEY, ADMIN_API_KEY, POSTGRES_PASSWORD." >&2
    exit 2
  fi

  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a

  for required_var in MORALIS_API_KEY ADMIN_API_KEY POSTGRES_PASSWORD; do
    if [[ -z "${!required_var:-}" ]]; then
      echo "Missing required env var: ${required_var}" >&2
      exit 2
    fi
  done

}

update_repo() {
  if [[ "${GIT_UPDATE}" != "true" ]]; then
    return
  fi

  if [[ ! -d "${REPO_ROOT}/.git" ]]; then
    echo "No git repo found at ${REPO_ROOT}; skipping git update."
    return
  fi

  git -C "${REPO_ROOT}" fetch origin "${DEPLOY_REF}"
  git -C "${REPO_ROOT}" checkout "${DEPLOY_REF}"
  git -C "${REPO_ROOT}" reset --hard "origin/${DEPLOY_REF}"
  git -C "${REPO_ROOT}" clean -fd -e "${SERVICE_DIR#${REPO_ROOT}/}/.env" -e "${SERVICE_DIR#${REPO_ROOT}/}/logs"
}

wait_for_health() {
  local start now url
  url="${HEALTH_URL:-http://127.0.0.1:${API_PUBLIC_PORT:-3001}/health}"
  start="$(date +%s)"

  while true; do
    if curl -fsS "${url}" >/dev/null; then
      echo "Healthcheck passed: ${url}"
      return
    fi

    now="$(date +%s)"
    if (( now - start >= HEALTH_TIMEOUT_SECONDS )); then
      echo "Healthcheck failed after ${HEALTH_TIMEOUT_SECONDS}s: ${url}" >&2
      docker compose -f "${COMPOSE_FILE}" ps >&2 || true
      docker compose -f "${COMPOSE_FILE}" logs --tail=200 api >&2 || true
      exit 1
    fi

    sleep 2
  done
}

main() {
  require_command git
  require_command docker
  require_command curl

  update_repo
  validate_env

  cd "${SERVICE_DIR}"
  docker compose -f "${COMPOSE_FILE}" config >/dev/null
  docker compose -f "${COMPOSE_FILE}" build
  docker compose -f "${COMPOSE_FILE}" up -d --remove-orphans
  wait_for_health
  docker compose -f "${COMPOSE_FILE}" ps
}

main "$@"
