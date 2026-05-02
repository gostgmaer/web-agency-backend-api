#!/usr/bin/env bash
set -euo pipefail

DOMAIN_SCHEME="${DOMAIN_SCHEME:-https}"
GATEWAY_PUBLIC_HOST="${GATEWAY_PUBLIC_HOST:-gateway-server.easydev.in}"
IAM_PUBLIC_HOST="${IAM_PUBLIC_HOST:-iam-service.easydev.in}"
PAYMENT_PUBLIC_HOST="${PAYMENT_PUBLIC_HOST:-payment.easydev.in}"

check() {
  local name="$1"
  local url="$2"
  echo "\n=== $name ==="
  echo "$url"
  curl --max-time 15 --silent --show-error "$url" || true
  echo
}

check_internal_container() {
  local name="$1"
  local container_name="$2"
  local url="$3"
  echo "\n=== $name ==="
  echo "container: $container_name"
  docker exec "$container_name" wget --max-redirect=0 --timeout=15 --quiet --server-response --output-document=- "$url" 2>/dev/null || true
  echo
}

check "Gateway Health" "${DOMAIN_SCHEME}://${GATEWAY_PUBLIC_HOST}/api/health"
check "Gateway Platform Health" "${DOMAIN_SCHEME}://${GATEWAY_PUBLIC_HOST}/api/platform-health"
check "IAM Health (Public)" "${DOMAIN_SCHEME}://${IAM_PUBLIC_HOST}/api/v1/iam/health"
check "Payment Health (Public)" "${DOMAIN_SCHEME}://${PAYMENT_PUBLIC_HOST}/api/v1/health"
check_internal_container "IAM Health (Internal)" "easydev-iam-platform" "http://127.0.0.1:3301/api/v1/iam/health"
check_internal_container "Payment Health (Internal)" "easydev-payment-service" "http://127.0.0.1:3302/api/v1/health"
check_internal_container "AI Communication Health (Private)" "easydev-communication-backend" "http://127.0.0.1:3303/api/v1/health"
check "Notification Health" "https://notification-service-iota.vercel.app/v1/health"
check "File Upload Health" "https://file-upload-service-zjtv.onrender.com/health"
