#!/usr/bin/env bash
# Targeted service deploy with schema sync, health checks, and rollback.
set -euo pipefail

SERVICE="${1:-}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
EASYDEV_ROOT="${EASYDEV_ROOT:-/home/opc/easydev}"
ROLLBACK_STATE="${ROLLBACK_STATE:-$HOME/.rollback-state}"

log() { echo "[deploy] $(date -u +%H:%M:%S) $*"; }
die() { log "ERROR: $*"; exit 1; }

configure_docker_credentials() {
  mkdir -p "$HOME/.docker"
  if [ ! -f "$HOME/.docker/config.json" ]; then
    printf '%s\n' '{"credsStore":""}' > "$HOME/.docker/config.json"
  fi
}

wait_for_container_health() {
  local container="$1"
  local label="${2:-$container}"
  local timeout="${3:-40}"
  local waited=0

  log "Waiting for ${label} to be healthy (up to ${timeout}s)"
  while [ "$waited" -lt "$timeout" ]; do
    local state
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || echo "missing")"
    if [ "$state" = "healthy" ] || [ "$state" = "running" ]; then
      log "${label} is healthy"
      return 0
    fi
    if [ "$state" = "unhealthy" ] || [ "$state" = "exited" ] || [ "$state" = "dead" ]; then
      log "${label} reported terminal status '${state}'"
      log "Recent logs for ${container}"
      docker logs --tail 80 "$container" 2>&1 | sed 's/^/[deploy]   /' || true
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done

  log "${label} did not become healthy within ${timeout}s"
  return 1
}

run_product_schema_sync() {
  local image="$1"
  log "Running one-shot schema sync for ai-automation-communication-service"
  docker run --rm \
    --env-file "${EASYDEV_ROOT}/env/.env.shared" \
    --env-file "${EASYDEV_ROOT}/env/.env.ai-automation-communication" \
    --network easydev-net \
    "$image" \
    sh -lc 'if [ -f scripts/sync-schema.mjs ]; then node scripts/sync-schema.mjs; else echo "sync-schema.mjs missing — rebuild image"; exit 1; fi'
}

save_rollback_digest() {
  local container="$1"
  local key="$2"
  if docker inspect "$container" >/dev/null 2>&1; then
    docker inspect --format '{{.Image}}' "$container" > "${ROLLBACK_STATE}.${key}"
  fi
}

rollback_image() {
  local container="$1"
  local key="$2"
  local rollback_file="${ROLLBACK_STATE}.${key}"
  [ -f "$rollback_file" ] || return 0
  local digest
  digest="$(cat "$rollback_file")"
  log "Rolling back ${container} to the previous image digest"
  docker tag "$digest" "ghcr.io/${GHCR_OWNER}/${key}:${IMAGE_TAG}" || true
  docker compose -p easydev-product -f "${EASYDEV_ROOT}/stacks/product/docker-compose.yml" up -d --no-deps "$container"
  wait_for_container_health "$container" "${container} (rollback)" 40 || true
}

[ -n "$SERVICE" ] || die "Usage: deploy-service.sh <gateway|ai-automation-communication-service>"

configure_docker_credentials

cd "$EASYDEV_ROOT" || die "Missing deploy root: $EASYDEV_ROOT"

case "$SERVICE" in
  gateway)
    COMPOSE_FILE="stacks/core/docker-compose.yml"
    COMPOSE_PROJECT="easydev-core"
    CONTAINER="gateway"
  ;;
  ai-automation-communication-service)
    COMPOSE_FILE="stacks/product/docker-compose.yml"
    COMPOSE_PROJECT="easydev-product"
    CONTAINER="ai-automation-communication-service"
  ;;
  *)
    die "Unsupported service: $SERVICE"
  ;;
esac

log "Saving rollback state to ${ROLLBACK_STATE}"
save_rollback_digest "$CONTAINER" "$SERVICE"

log "Pulling ${SERVICE} image (tag: ${IMAGE_TAG})"
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" pull "$CONTAINER"

if [ "$SERVICE" = "ai-automation-communication-service" ]; then
  IMAGE_REF="$(docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" images -q "$CONTAINER" | head -n 1)"
  [ -n "$IMAGE_REF" ] || die "Could not resolve image for ${SERVICE}"
  run_product_schema_sync "$IMAGE_REF"
fi

log "Deploying ${SERVICE} only"
if ! docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --no-deps "$CONTAINER"; then
  die "Failed to start ${SERVICE}"
fi

if ! wait_for_container_health "$CONTAINER" "$SERVICE" 40; then
  rollback_image "$CONTAINER" "$SERVICE"
  die "Deploy failed health checks for ${SERVICE}; rollback completed"
fi

log "Deploy succeeded for ${SERVICE}"
