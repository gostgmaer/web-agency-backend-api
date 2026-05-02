#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CORE_ENV_FILE="${CORE_ENV_FILE:-.env.core}"
APPS_ENV_FILE="${APPS_ENV_FILE:-.env.apps}"

if [[ ! -f "$CORE_ENV_FILE" ]]; then
  echo "Missing $CORE_ENV_FILE"
  echo "Create it from .env.core.example"
  exit 1
fi

if [[ ! -f "$APPS_ENV_FILE" ]]; then
  echo "Missing $APPS_ENV_FILE"
  echo "Create it from .env.apps.example"
  exit 1
fi

require_env_key() {
  local file="$1"
  local key="$2"
  if ! grep -q "^${key}=" "$file"; then
    echo "Missing ${key} in ${file}"
    exit 1
  fi
}

require_env_key "$CORE_ENV_FILE" "IAM_IMAGE"
require_env_key "$CORE_ENV_FILE" "PAYMENT_IMAGE"
require_env_key "$APPS_ENV_FILE" "GATEWAY_IMAGE"
require_env_key "$APPS_ENV_FILE" "COMMUNICATION_IMAGE"
require_env_key "$APPS_ENV_FILE" "IAM_PUBLIC_HOST"
require_env_key "$APPS_ENV_FILE" "PAYMENT_PUBLIC_HOST"
require_env_key "$APPS_ENV_FILE" "GATEWAY_PUBLIC_HOST"

IAM_PUBLIC_HOST="$(grep '^IAM_PUBLIC_HOST=' "$APPS_ENV_FILE" | tail -n 1 | cut -d= -f2-)"
PAYMENT_PUBLIC_HOST="$(grep '^PAYMENT_PUBLIC_HOST=' "$APPS_ENV_FILE" | tail -n 1 | cut -d= -f2-)"
GATEWAY_PUBLIC_HOST="$(grep '^GATEWAY_PUBLIC_HOST=' "$APPS_ENV_FILE" | tail -n 1 | cut -d= -f2-)"

wait_for_health() {
  local container_name="$1"
  local retries="${2:-50}"
  local sleep_seconds="${3:-5}"

  echo "Waiting for health: $container_name"
  for ((i=1; i<=retries; i++)); do
    local state
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_name" 2>/dev/null || true)"
    if [[ "$state" == "healthy" || "$state" == "running" ]]; then
      echo "Healthy: $container_name ($state)"
      return 0
    fi
    sleep "$sleep_seconds"
  done

  echo "Container did not become healthy in time: $container_name"
  docker logs --tail 120 "$container_name" || true
  return 1
}

backup_running_image() {
  local container_name="$1"
  local backup_ref="easydev-backup/${container_name}:latest"

  if ! docker inspect "$container_name" >/dev/null 2>&1; then
    return 0
  fi

  local current_ref
  current_ref="$(docker inspect --format '{{.Config.Image}}' "$container_name" 2>/dev/null || true)"
  if [[ -z "$current_ref" ]]; then
    return 0
  fi

  docker image tag "$current_ref" "$backup_ref" >/dev/null 2>&1 || true
  echo "Backup tagged: $backup_ref <- $current_ref"
}

cleanup_service_repository() {
  local container_name="$1"
  local backup_ref="easydev-backup/${container_name}:latest"

  if ! docker inspect "$container_name" >/dev/null 2>&1; then
    return 0
  fi

  local current_ref current_repo current_id backup_id
  current_ref="$(docker inspect --format '{{.Config.Image}}' "$container_name")"
  current_repo="${current_ref%:*}"
  current_id="$(docker inspect --format '{{.Image}}' "$container_name")"
  backup_id="$(docker image inspect --format '{{.Id}}' "$backup_ref" 2>/dev/null || true)"

  while IFS=' ' read -r image_ref image_id; do
    [[ -z "$image_ref" || -z "$image_id" ]] && continue
    if [[ "$image_id" == "$current_id" ]]; then
      continue
    fi
    if [[ -n "$backup_id" && "$image_id" == "$backup_id" ]]; then
      continue
    fi
    docker rmi "$image_ref" >/dev/null 2>&1 || true
  done < <(docker images "$current_repo" --format '{{.Repository}}:{{.Tag}} {{.ID}}' | sort -u)
}

echo "Ensuring shared Docker network exists"
docker network inspect easydev-services >/dev/null 2>&1 || docker network create easydev-services

echo "Tagging backups for rollback"
backup_running_image easydev-iam-platform
backup_running_image easydev-payment-service
backup_running_image easydev-communication-backend
backup_running_image easydev-web-agency-backend

echo "Deploying core project (IAM + Payment)"
docker compose --env-file "$CORE_ENV_FILE" -f compose.core.yml pull
docker compose --env-file "$CORE_ENV_FILE" -f compose.core.yml up -d --remove-orphans

echo "Ensuring core database schemas exist"
docker compose --env-file "$CORE_ENV_FILE" -f compose.core.yml run --rm --no-deps iam-platform npx prisma db push
docker compose --env-file "$CORE_ENV_FILE" -f compose.core.yml run --rm --no-deps payment-service npx prisma db push

wait_for_health easydev-iam-platform
wait_for_health easydev-payment-service

echo "Running default seeds"
docker compose --env-file "$CORE_ENV_FILE" -f compose.core.yml exec -T iam-platform node dist/seed/prisma/seed.js
if ! docker compose --env-file "$CORE_ENV_FILE" -f compose.core.yml exec -T payment-service node dist/seed/prisma/seed.js; then
  echo "Payment seed returned non-zero. Continuing because plans may already exist."
fi

echo "Deploying app project (Gateway + AI Communication)"
docker compose --env-file "$APPS_ENV_FILE" -f compose.apps.yml pull
docker compose --env-file "$APPS_ENV_FILE" -f compose.apps.yml up -d --remove-orphans

wait_for_health easydev-communication-backend
wait_for_health easydev-web-agency-backend
wait_for_health easydev-edge-proxy

echo "Cleaning old service images (keeping active + one backup)"
cleanup_service_repository easydev-iam-platform
cleanup_service_repository easydev-payment-service
cleanup_service_repository easydev-communication-backend
cleanup_service_repository easydev-web-agency-backend
docker image prune -f >/dev/null 2>&1 || true

echo "Deployment complete"
echo "Public API base URLs:"
echo "  IAM:      https://${IAM_PUBLIC_HOST}"
echo "  Payment:  https://${PAYMENT_PUBLIC_HOST}"
echo "  Gateway:  https://${GATEWAY_PUBLIC_HOST}"
echo "  AI Communication is private behind gateway"

echo "Run health verification: ./check-health.sh"
