# Web Agency Backend API — Copilot Instructions

## Service Role

This repository is the public gateway for the EasyDev workspace. Browser clients should call this service, not the downstream services directly.

Current responsibilities:

- public lead submission and lead management routes in this repo
- newsletter subscription and confirmation routes in this repo
- proposal upload orchestration in this repo
- pricing calculator routes in this repo
- payment adapter routes that call `payment-microservice`
- AI Communication provisioning and launch routes that call the product backend and IAM
- proxy routes for IAM, file upload, and customer product APIs

## Integration Topology

### 1. IAM service

Workspace source: `../multi-tannet-auth-services`

Recommended local URL:

```text
http://localhost:4002/api/v1/iam
```

Rules:

- IAM is the only service that issues access and refresh tokens.
- `middleware/auth.js` in this repo only verifies JWTs with the shared secret.
- The JWT claims must satisfy `iss === 'user-auth-service'` and `aud === 'dashboard-app'`.
- Use `GET /api/auth/me` for session validation. Do not build new integrations around `/api/auth/token/verify`.
- Gateway auth proxies should target the IAM routes behind `AUTH_SERVICE_URL`.

### 2. Payment service

Workspace source: `../payment-microservice`

Recommended local URL:

```text
http://localhost:3200/api/v1
```

Rules:

- Payment verification, subscriptions, invoices, and payment methods belong there.
- This repo may adapt or proxy payment flows, but should not reimplement payment state machines locally.

### 3. AI Communication product

Workspace source: `../Product/ai automation communication`

Recommended local URLs:

```text
Backend:  http://localhost:3001/api/v1
Frontend: http://localhost:3002
```

Rules:

- Customer product launch is IAM SSO based.
- Product provisioning must remain server-to-server.
- Never expose `COMMUNICATION_API_KEY` to the browser.
- The product backend validates IAM JWTs and IAM SSO tokens.

### 4. File upload service

Rules:

- All durable file storage belongs to the file upload service.
- This repo may only keep temporary local proposal HTML under `uploads/proposals`.

### 5. Email service

Rules:

- All transactional mail goes through `utils/email.js`.
- Never call `nodemailer` directly from routes or services.

## Route Ownership

### Owned in this repo

- `/api/leads/*`
- `/api/newsletter/*`
- `/api/upload/proposal`
- `/api/calculator/*`
- `/api/payments/*` adapter routes
- `/api/communication/provision`
- `/api/communication/launch`

### Proxied through this repo

- `/api/auth/*`
- `/api/rbac/*`
- `/api/users/*`
- `/api/tenants/*`
- `/api/sessions/*`
- `/api/iam/*`
- `/api/files/*`
- `/api/customer/*`
- selected `/api/communication/admin/*` routes

## Auth Rules

- Use `authenticate` for protected gateway routes.
- Use `authorize(...)` only when the route requires explicit roles.
- `req.user` comes from the verified JWT payload; do not load a local user record just to validate auth.
- Never sign JWTs in this repository.
- Never add local login, registration, token verify, or token refresh implementations here.

`req.user` shape:

```js
{
  id: string,
  email: string,
  role: string,
  tenantId: string,
  sessionId: string,
}
```

## Lead Rules

- Standard lead submission and lead CRUD are owned locally in this repo now.
- Do not reintroduce an external lead proxy for the existing `/api/leads/*` surface unless the task explicitly requires it.
- Preserve the current response envelope: `{ success, message, data? }`.

## Payment And Product Provisioning Rules

- The normal customer purchase path is `EasyDev -> gateway -> payment service`.
- Successful payment verification can trigger AI Communication provisioning.
- If you touch provisioning flows, keep the sequence consistent:
  1. verify payment
  2. create local product account
  3. create or resolve IAM user
  4. link IAM user back to the product business
- Do not move these secrets or orchestration details into frontend code.

## Code Conventions

- Node.js 18+ with ES modules.
- Routes live in `routes/`.
- Validation lives in `validation/`.
- Shared helpers live in `utils/`.
- Propagate failures with `next(error)`.
- Keep side effects such as email dispatch and remote notifications non-blocking when the route does not need to wait for them.

## Environment Variables That Matter For Integration

```env
PORT=3500
JWT_ACCESS_SECRET=match-iam-JWT_SECRET
JWT_ISSUER=user-auth-service
JWT_AUDIENCE=dashboard-app
AUTH_SERVICE_URL=http://localhost:4002
PAYMENT_SERVICE_URL=http://localhost:3200
COMMUNICATION_SERVICE_URL=http://localhost:3001
FILE_UPLOAD_SERVICE_URL=http://localhost:4001
EMAIL_SERVICE_URL=http://localhost:4000
```

## Avoid These Mistakes

- Adding browser-facing calls directly to IAM or product services when the gateway already owns the contract.
- Reintroducing `/api/auth/token/verify` in new code.
- Using `JWT_SECRET` instead of `JWT_ACCESS_SECRET` in this repo.
- Duplicating payment, IAM, email, or durable file storage logic locally.
- Exposing service-to-service API keys to the browser.
