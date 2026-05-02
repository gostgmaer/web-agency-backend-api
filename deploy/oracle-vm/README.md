# Oracle VM Backend Deployment

This deployment bundle runs a single-VM production topology with direct image transfer deployment:

- Core stack: IAM + Payment + shared Postgres/Redis
- App stack: Gateway + AI Communication + Caddy edge proxy
- External MongoDB remains hosted outside Oracle VM

AI Communication backend is private (no public host port exposure), is accessed through gateway flows, and uses the shared core Postgres/Redis services.
Its tables are isolated in a dedicated Postgres schema (`COMM_DB_SCHEMA`, default `communication`).

If host Nginx already owns ports 80/443 on the VM, set `ENABLE_EDGE_PROXY=false` in `.env.apps` so deploys skip the Docker Caddy service.

Service port policy (to avoid conflicts with other projects on the same VM):

- 3300: web-agency gateway (public)
- 3301: IAM (public via iam-service.easydev.in)
- 3302: payment (public via payment.easydev.in)
- 3303: AI communication (internal)
- 3304: core postgres (internal)
- 3305: core redis (internal)

Core database runtime image: `postgres:17-alpine`.

## Public Domains

- Gateway: `https://gateway-server.easydev.in`
- IAM: `https://iam-service.easydev.in`
- Payment: `https://payment.easydev.in`

AI Communication stays internal-only behind the gateway.

## On-Merge CI/CD Behavior

Production deploy workflows are maintained for:

1. IAM repository
2. Payment repository
3. Gateway repository
4. AI Communication repository (targeted update of communication-backend only)

AI Communication is not deployed as a separate public project surface. It stays private behind gateway and is deployed in the same Oracle topology.

The AI repository workflow updates only `communication-backend` and does not run a full stack deploy, so gateway is not redeployed for AI-only changes.

Workflow behavior:

1. Build Docker image in GitHub Actions.
2. Save image as archive and copy it to Oracle VM over SSH.
3. Load image locally on VM and update `.env.core` or `.env.apps` tag.
4. Run `deploy.sh` over SSH.

Deployment script behavior:

- Uses local VM images by default (`SKIP_PULL=true`).
- Tags current running image as one rollback backup.
- Deploys with `docker compose up -d --remove-orphans`.
- Removes old images and keeps only active image + one backup image per service.

## Required GitHub Secrets (IAM/Payment/Gateway/AI Repos)

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`

## VM Directory Layout

```text
/home/opc/easydev-backends/
  deploy/
    oracle-vm/
      compose.core.yml
      compose.apps.yml
      Caddyfile
      .env.core
      .env.apps
      deploy.sh
      check-health.sh
```

## Setup

```bash
cd /home/opc/easydev-backends/deploy/oracle-vm
cp .env.core.example .env.core
cp .env.apps.example .env.apps
chmod +x deploy.sh check-health.sh
./deploy.sh
```

## Verify

```bash
./check-health.sh
```

`/api/platform-health` on gateway includes IAM, Payment, AI Communication, Notification, and File Upload checks.

## Required DNS

Point the following A records to your Oracle VM public IP:

- `gateway-server.easydev.in`
- `iam-service.easydev.in`
- `payment.easydev.in`

Ports 80 and 443 must be open in Oracle security lists / firewall for certificate issuance and HTTPS routing.

## Optional Worker

```bash
docker compose --env-file .env.core -f compose.core.yml --profile worker up -d payment-worker
```
