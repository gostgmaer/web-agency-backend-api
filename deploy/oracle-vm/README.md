# Oracle VM Backend Deployment

This deployment bundle runs a single-VM production topology with image-based deployment:

- Core stack: IAM + Payment + shared Postgres/Redis
- App stack: Gateway + AI Communication + app Postgres/Redis + Caddy edge proxy
- External MongoDB remains hosted outside Oracle VM

AI Communication backend is private (no public host port exposure) and is accessed through gateway flows.

## Public Domains

- IAM: `https://iam-service.easydev.in`
- Payment: `https://payment.easydev.in`
- Gateway: `https://gateway-server.easydev.in`

## On-Merge CI/CD Behavior

Production deploy workflows are maintained for:

1. IAM repository
2. Payment repository
3. Gateway repository
4. AI Communication repository (targeted update of communication-backend only)

AI Communication is not deployed as a separate public project surface. It stays private behind gateway and is deployed in the same Oracle topology.

The AI repository workflow updates only `communication-backend` and does not run a full stack deploy, so gateway is not redeployed for AI-only changes.

Workflow behavior:

1. Build and push Docker image to Docker Hub.
2. Update image tag in Oracle VM env (`.env.core`/`.env.apps`).
3. Run `deploy.sh` over SSH.

Deployment script behavior:

- Pulls latest service images from registry.
- Tags current running image as one rollback backup.
- Deploys with `docker compose up -d --remove-orphans`.
- Removes old images and keeps only active image + one backup image per service.

## Required GitHub Secrets (IAM/Payment/Gateway Repos)

- `DOCKERHUB_NAMESPACE`
- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`
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

- `iam-service.easydev.in`
- `payment.easydev.in`
- `gateway-server.easydev.in`

Ports 80 and 443 must be open in Oracle security lists / firewall for certificate issuance and HTTPS routing.

## Optional Worker

```bash
docker compose --env-file .env.core -f compose.core.yml --profile worker up -d payment-worker
```
