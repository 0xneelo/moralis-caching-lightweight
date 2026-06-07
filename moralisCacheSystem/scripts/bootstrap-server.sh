#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/0xneelo/moralis-caching-lightweight.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/moralis-caching-lightweight}"
APP_SUBDIR="${APP_SUBDIR:-moralisCacheSystem}"
MORALIS_API_KEY="${MORALIS_API_KEY:-}"

require_root_or_sudo() {
  if [[ "$(id -u)" -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
    echo "Run as root or install sudo." >&2
    exit 1
  fi
}

as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

install_base_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    as_root apt-get update
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg git openssl
    return
  fi

  echo "Unsupported OS: install git, curl, openssl, and Docker manually, then run scripts/deploy.sh." >&2
  exit 1
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Docker missing. Non-apt OS detected. Install Docker Engine + Compose plugin manually." >&2
    exit 1
  fi

  as_root install -m 0755 -d /etc/apt/keyrings
  . /etc/os-release
  if [[ "${ID}" != "ubuntu" && "${ID}" != "debian" ]]; then
    echo "Docker auto-install supports Ubuntu/Debian only. Detected ID=${ID}." >&2
    exit 1
  fi

  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | as_root tee /etc/apt/keyrings/docker.asc >/dev/null
  as_root chmod a+r /etc/apt/keyrings/docker.asc

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    | as_root tee /etc/apt/sources.list.d/docker.list >/dev/null

  as_root env DEBIAN_FRONTEND=noninteractive apt-get remove -y docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc || true
  as_root apt-get update
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  as_root systemctl enable --now docker
}

clone_or_update_repo() {
  as_root mkdir -p "$(dirname "${APP_DIR}")"

  if [[ -d "${APP_DIR}/.git" ]]; then
    git -C "${APP_DIR}" fetch origin "${BRANCH}"
    git -C "${APP_DIR}" checkout "${BRANCH}"
    git -C "${APP_DIR}" reset --hard "origin/${BRANCH}"
    return
  fi

  if [[ -e "${APP_DIR}" ]]; then
    echo "APP_DIR exists but is not a git repo: ${APP_DIR}" >&2
    echo "Move it away or choose another APP_DIR." >&2
    exit 1
  fi

  git clone --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
}

create_env_if_missing() {
  local service_dir="${APP_DIR}/${APP_SUBDIR}"
  local env_file="${service_dir}/.env"

  if [[ -f "${env_file}" ]]; then
    chmod 600 "${env_file}"
    return
  fi

  local postgres_password admin_api_key
  postgres_password="$(openssl rand -hex 32)"
  admin_api_key="mcs_admin_$(openssl rand -hex 32)"

  if [[ -z "${MORALIS_API_KEY}" ]]; then
    MORALIS_API_KEY="PUT_MORALIS_API_KEY_HERE"
  fi

  cat > "${env_file}" <<ENV
NODE_ENV=production
PORT=3001
API_PUBLIC_PORT=3001
LOG_LEVEL=info

MORALIS_API_KEY=${MORALIS_API_KEY}
ADMIN_API_KEY=${admin_api_key}
POSTGRES_PASSWORD=${postgres_password}

DATABASE_URL=postgres://postgres:${postgres_password}@postgres:5432/moralis_cache
REDIS_URL=redis://redis:6379

MORALIS_DAILY_CU_BUDGET=5000000
CHART_PROVIDER_ENABLED=true
MAX_SYNC_MORALIS_PAGES=3
MAX_SYNC_GAP_CANDLES=3000
DEFAULT_CURRENCY=usd
EXTERNAL_API_KEY_REQUEST_RATE_LIMIT=600
EXTERNAL_API_KEY_CACHE_MISS_RATE_LIMIT=20
EXTERNAL_API_KEY_DAILY_CU_BUDGET=100000
ENV

  chmod 600 "${env_file}"
  echo "Created ${env_file}"
}

main() {
  require_root_or_sudo
  install_base_packages
  install_docker
  clone_or_update_repo
  create_env_if_missing

  echo "Bootstrap complete."
  echo "Repo: ${APP_DIR}"
  echo "Service dir: ${APP_DIR}/${APP_SUBDIR}"
  echo "Next: edit ${APP_DIR}/${APP_SUBDIR}/.env if MORALIS_API_KEY is placeholder, then run:"
  echo "cd ${APP_DIR}/${APP_SUBDIR} && ./scripts/deploy.sh"
}

main "$@"
