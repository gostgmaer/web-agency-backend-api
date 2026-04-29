# Web Agency Backend API

`web-agency-backend-api` is the single browser-facing API origin for the EasyDev website and member portal. It combines gateway behavior with several owned business modules so the frontend can integrate against one `/api` base URL instead of talking directly to every internal service.

## What This Service Owns

| Area | Route prefix | Notes |
|---|---|---|
| Health and readiness | `/api/health`, `/api/ready`, `/api/platform-health` | local health plus aggregated upstream checks |
| Leads CRM | `/api/leads/*` | public lead submit and authenticated CRM, proposal, contract, note, import, export, attachment flows |
| Newsletter | `/api/newsletter/*` | MongoDB-backed double opt-in lifecycle |
| Payments adapter | `/api/payments/*` | public checkout plus authenticated subscription and billing operations, delegated to `payment-microservice` |
| AI Communication provisioning and launch | `/api/communication/*` | post-purchase provisioning and IAM-backed SSO launch |
| Proposal HTML upload | `/api/upload/proposal` | stores local HTML under `uploads/proposals` |
| Budget calculator | `/api/calculator/*` | public cost estimation |
| Postman collection | `/api/postman-collection` | direct import helper |

## What This Service Proxies

| Gateway prefix | Downstream target |
|---|---|
| `/api/auth/*` | IAM auth module |
| `/api/rbac/*` | IAM RBAC module |
| `/api/users/*` | IAM users module |
| `/api/tenants/*` | IAM tenants module |
| `/api/sessions/*` | IAM sessions module |
| `/api/iam/*` | IAM health, logs, stats, security, feature flags, apps, settings |
| `/api/files/*` | file upload service |
| `/api/customer/*` | AI Communication customer APIs |

## Recommended Local Port Map

The workspace contains multiple services with overlapping defaults. Use a stable local map like this:

| Service | Recommended port |
|---|---|
| `easydev` | `3000` |
| `multi-tannet-auth-services` | `3100` |
| `payment-microservice` | `3200` |
| `ai automation communication` backend | `3001` |
| `ai automation communication` frontend | `3002` |
| `web-agency-backend-api` | `3500` |

## Critical Environment Variables

Create `.env` with values that match the rest of the stack:

```env
PORT=3500
NODE_ENV=development
FRONTEND_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3000,http://localhost:3002
MONGODB_URI=mongodb://localhost:27017/web-agency

AUTH_SERVICE_URL=http://localhost:4002
FILE_UPLOAD_SERVICE_URL=http://localhost:4001
COMMUNICATION_URL=http://localhost:3001/api/v1
PAYMENT_SERVICE_URL=http://localhost:3200
EMAIL_SERVICE_URL=http://localhost:4000

JWT_ACCESS_SECRET=change-me-and-match-iam-jwt-secret
JWT_ISSUER=user-auth-service
JWT_AUDIENCE=dashboard-app

COMMUNICATION_API_KEY=change-me-and-match-ai-comm-sales-api-key
PAYMENT_SERVICE_API_KEY=change-me-plaintext-key-for-payment-service
ADMIN_EMAIL=admin@easydev.local
TENANT_ID=easydev
```

Shared-secret rules:

- `JWT_ACCESS_SECRET` must match IAM `JWT_SECRET` if you want local JWT verification to succeed.
- `COMMUNICATION_API_KEY` must match AI Communication `SALES_API_KEY`.
- `PAYMENT_SERVICE_API_KEY` must be the plaintext key whose hash is trusted by the payment microservice.

## Install And Run

```bash
pnpm install
pnpm dev
```

Other scripts:

```bash
pnpm start
pnpm start:cluster
```

## Browser Integration Contract

The frontend should use this service as its only public API base:

```text
http://localhost:3500/api
```

That gives the browser one origin for:

- public lead and newsletter submission
- member authentication through IAM proxies
- checkout and billing flows
- customer product data from AI Communication
- AI Communication SSO launch

## Current Integration Flows

### Lead submit

Public websites submit to `POST /api/leads/submit` with `x-tenant-id`. The same module then exposes authenticated CRM routes for staff and member dashboards.

### Newsletter

Newsletter is fully owned here and uses double opt-in:

1. `POST /api/newsletter/subscribe`
2. `GET /api/newsletter/confirm/:token`
3. `POST /api/newsletter/unsubscribe`

### Auth

Auth is proxied to IAM. The supported path family is `POST /api/auth/*` and `GET /api/auth/me`.

Important:

- New integrations should use `GET /api/auth/me` to validate a session.
- Do not rely on `/api/auth/token/verify`; the current IAM controller does not implement it.

### Checkout and provisioning

Public checkout is:

1. `GET /api/payments/methods`
2. `POST /api/payments/initiate`
3. `POST /api/payments/verify`

The verify step triggers downstream provisioning through `utils/productProvisioner.js`. For the EasyDev Communication product that means:

- create the product-side account in the AI Communication backend
- provision or resolve the shared IAM user
- link the IAM user back to the AI Communication business

### AI Communication launch

Authenticated users open the product with `GET /api/communication/launch`. The gateway generates an IAM SSO token and returns a product launch URL.

## Common Mistakes To Avoid

- Pointing the frontend directly at IAM or AI Communication instead of this gateway.
- Running IAM on `3000` and forgetting to update `AUTH_SERVICE_URL`.
- Assuming this repo still proxies lead flows to a separate lead microservice. The current code owns `/api/leads/*` locally.
- Treating payment verify as a confirmation-only step. It is also the provisioning trigger.
- Using `/api/auth/token/verify` in new clients.

## Verification Checklist

After wiring the environment, verify these endpoints in order:

1. `GET /api/health`
2. `GET /api/ready`
3. `GET /api/payments/methods`
4. `POST /api/leads/submit`
5. `POST /api/newsletter/subscribe`
6. `POST /api/auth/login`
7. `GET /api/auth/me`
8. `GET /api/payments/subscriptions`
9. `GET /api/communication/launch`

## Deeper Reference

See `docs/API.md` for the current route catalog, request examples, and end-to-end workflows.
