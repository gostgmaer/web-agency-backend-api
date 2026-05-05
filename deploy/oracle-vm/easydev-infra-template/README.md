# EasyDev Infra Template (Production)

This template implements the target production architecture on Oracle Linux using Docker Compose, GHCR, and GitHub Actions.

## Final architecture

Project `easydev-core`:
- gateway
- auth-service
- payment-service
- postgres
- redis

Project `easydev-product`:
- ai-automation-communication-service
- future product services

Shared network:
- `easydev-net` (external Docker network)

Internal DNS examples:
- `http://auth-service:3000`
- `http://payment-service:3000`
- `http://ai-automation-communication-service:3000`

## Oracle Linux target folder structure

```text
/home/opc/easydev/
├── env/
│   ├── .env.shared.example
│   ├── .env.gateway.example
│   ├── .env.auth.example
│   ├── .env.payment.example
│   └── .env.ai-automation-communication.example
├── stacks/
│   ├── core/
│   │   ├── docker-compose.yml
│   │   └── postgres-init/
│   │       └── 001-create-schemas.sql
│   └── product/
│       └── docker-compose.yml
└── .github/
    └── workflows/
        └── deploy-infra.yml
```

Runtime env files (never commit):
- `/home/opc/easydev/env/.env.shared`
- `/home/opc/easydev/env/.env.gateway`
- `/home/opc/easydev/env/.env.auth`
- `/home/opc/easydev/env/.env.payment`
- `/home/opc/easydev/env/.env.ai-automation-communication`

## Important implementation notes

- Only `gateway` publishes a host port.
- All other services are internal-only and reachable by Docker DNS on `easydev-net`.
- PostgreSQL and Redis live only in `easydev-core` and are consumed from `easydev-product` through the shared network.
- Database isolation is schema-based (`auth`, `payment`, `ai_automation_communication`).
- Persistent volumes are explicitly named:
  - `easydev-postgres-data`
  - `easydev-redis-data`

## Prerequisites

- Oracle Linux VM
- GitHub SSH key configured on VM
- GHCR access token with read access for deploy host
- Repositories:
  - `easydev-core` (service source repo)
  - `easydev-product` (service source repo)
  - `easydev-infra` (this infra repo)

## Initial setup commands (Oracle Linux)

### 1) SSH into VM

```bash
ssh -i ~/.ssh/id_rsa opc@<VM_PUBLIC_IP>
```

### 2) Install Docker and tooling (if needed)

```bash
sudo dnf -y update
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git
sudo systemctl enable --now docker
sudo usermod -aG docker opc
newgrp docker
```

### 3) Create target folders

```bash
mkdir -p /home/opc/easydev/env
mkdir -p /home/opc/easydev/stacks/core
mkdir -p /home/opc/easydev/stacks/product
```

### 4) Create shared external network

```bash
docker network inspect easydev-net >/dev/null 2>&1 || docker network create easydev-net
```

### 5) Clone infra repository

```bash
git clone git@github.com:<YOUR_ORG>/easydev-infra.git /home/opc/easydev
cd /home/opc/easydev
```

## Environment setup commands

### 1) Create runtime env files from templates

```bash
cp env/.env.shared.example env/.env.shared
cp env/.env.gateway.example env/.env.gateway
cp env/.env.auth.example env/.env.auth
cp env/.env.payment.example env/.env.payment
cp env/.env.ai-automation-communication.example env/.env.ai-automation-communication
```

### 2) Edit env files

```bash
vi env/.env.shared
vi env/.env.gateway
vi env/.env.auth
vi env/.env.payment
vi env/.env.ai-automation-communication
```

### 3) Lock down secrets

```bash
chmod 600 env/.env.shared env/.env.gateway env/.env.auth env/.env.payment env/.env.ai-automation-communication
```

## First deployment

### 1) Login to GHCR

```bash
echo "<GHCR_PAT>" | docker login ghcr.io -u "<GHCR_USERNAME>" --password-stdin
```

### 2) Deploy easydev-core

```bash
docker compose -p easydev-core -f stacks/core/docker-compose.yml pull
docker compose -p easydev-core -f stacks/core/docker-compose.yml up -d
```

### 3) Deploy easydev-product

```bash
docker compose -p easydev-product -f stacks/product/docker-compose.yml pull
docker compose -p easydev-product -f stacks/product/docker-compose.yml up -d
```

## Verification commands

### Running containers

```bash
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"
```

### Logs

```bash
docker logs --tail=200 gateway
docker logs --tail=200 auth-service
docker logs --tail=200 payment-service
docker logs --tail=200 ai-automation-communication-service
```

### Network members

```bash
docker network inspect easydev-net --format '{{json .Containers}}' | jq
```

### Validate env inside container

```bash
docker exec auth-service printenv | grep -E 'DATABASE_URL|REDIS_URL|JWT_ISSUER|JWT_AUDIENCE'
```

### Curl between containers (Docker DNS)

```bash
docker exec gateway sh -lc 'wget -qO- http://auth-service:3000/health'
docker exec gateway sh -lc 'wget -qO- http://payment-service:3000/health'
docker exec gateway sh -lc 'wget -qO- http://ai-automation-communication-service:3000/health'
```

## GitHub Actions

### A) Service repositories

Use templates in `docs/workflows/`:
- `docs/workflows/easydev-core-build-and-push.yml`
- `docs/workflows/easydev-product-build-and-push.yml`

Expected behavior:
- Trigger on push to `main`
- Build ARM64 images
- Push `latest` and `sha` tags to GHCR

### B) Infrastructure repository

Workflow file:
- `.github/workflows/deploy-infra.yml`

Expected behavior on push to `main`:
1. SSH to VM
2. `cd /home/opc/easydev`
3. `git pull --ff-only`
4. Deploy core stack:
   - `docker compose -p easydev-core -f stacks/core/docker-compose.yml pull`
   - `docker compose -p easydev-core -f stacks/core/docker-compose.yml up -d`
5. Deploy product stack:
   - `docker compose -p easydev-product -f stacks/product/docker-compose.yml pull`
   - `docker compose -p easydev-product -f stacks/product/docker-compose.yml up -d`

## Deployment behavior guarantees

- `docker compose up -d` only recreates containers whose config or image changed.
- Unchanged containers keep running.
- PostgreSQL and Redis persistence survives deployments because data volumes are named and mounted.

## Later maintenance commands

### Edit env files

```bash
vi /home/opc/easydev/env/.env.auth
vi /home/opc/easydev/env/.env.payment
```

### Add new env variable

```bash
echo 'NEW_FLAG=true' >> /home/opc/easydev/env/.env.ai-automation-communication
chmod 600 /home/opc/easydev/env/.env.ai-automation-communication
```

### Redeploy one service only

```bash
docker compose -p easydev-core -f /home/opc/easydev/stacks/core/docker-compose.yml up -d --no-deps auth-service
docker compose -p easydev-product -f /home/opc/easydev/stacks/product/docker-compose.yml up -d --no-deps ai-automation-communication-service
```

### Add a new product service

1. Add a service block to `/home/opc/easydev/stacks/product/docker-compose.yml`.
2. Add `env/.env.<new-service>.example` and create `env/.env.<new-service>`.
3. Keep service internal (`expose: 3000`, no `ports`).
4. Redeploy:

```bash
docker compose -p easydev-product -f /home/opc/easydev/stacks/product/docker-compose.yml pull <new-service>
docker compose -p easydev-product -f /home/opc/easydev/stacks/product/docker-compose.yml up -d <new-service>
```

### Remove a service

```bash
docker compose -p easydev-product -f /home/opc/easydev/stacks/product/docker-compose.yml stop <service>
docker compose -p easydev-product -f /home/opc/easydev/stacks/product/docker-compose.yml rm -f <service>
```

### Rollback

```bash
# Example rollback to known-good tag

docker pull ghcr.io/<YOUR_ORG>/ai-automation-communication-service:<KNOWN_GOOD_TAG>
docker tag ghcr.io/<YOUR_ORG>/ai-automation-communication-service:<KNOWN_GOOD_TAG> ghcr.io/<YOUR_ORG>/ai-automation-communication-service:latest
docker compose -p easydev-product -f /home/opc/easydev/stacks/product/docker-compose.yml up -d --no-deps ai-automation-communication-service
```

## Troubleshooting commands

```bash
# Validate compose files

docker compose -f /home/opc/easydev/stacks/core/docker-compose.yml config
docker compose -f /home/opc/easydev/stacks/product/docker-compose.yml config

# Check service health states

docker inspect --format '{{.Name}} {{.State.Status}} {{.State.Health.Status}}' gateway auth-service payment-service postgres redis ai-automation-communication-service

# Inspect DB connectivity from app containers

docker exec auth-service sh -lc 'getent hosts postgres'
docker exec ai-automation-communication-service sh -lc 'getent hosts redis'

# Check Redis auth

docker exec redis sh -lc 'redis-cli -a "$REDIS_PASSWORD" ping'

# Tail live logs for one service

docker logs -f --tail=200 ai-automation-communication-service
```

## Production best practices

- Pin production deploys to immutable image tags or digests, not only `latest`.
- Keep VM firewall open only for SSH and gateway public port.
- Enable nightly PostgreSQL backups and weekly restore drills.
- Use separate Redis DB indexes (or key prefixes) per service domain.
- Keep strict schema-level separation and migration ownership per service.
- Use healthchecks and restart policies for fast self-healing.
- Keep GHCR pull credentials scoped and rotated regularly.
- Keep env files encrypted at rest when possible and always `chmod 600`.
- Add metrics/log aggregation (Prometheus + Grafana + Loki or equivalent).
- Use blue/green or canary for high-risk service updates.
