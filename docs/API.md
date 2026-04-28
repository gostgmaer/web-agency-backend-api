# Web Agency Backend API Reference

This document is the current integration contract for `web-agency-backend-api`.

## Base URL

```text
Local: http://localhost:3500/api
```

Use the gateway as the only browser-facing base URL.

## Recommended Local Topology

| Service | Port | Why it matters here |
|---|---|---|
| `easydev` | `3000` | browser client |
| `multi-tannet-auth-services` | `3100` | `AUTH_SERVICE_URL` |
| `payment-microservice` | `3200` | `PAYMENT_SERVICE_URL` |
| `ai automation communication` backend | `3001` | `COMMUNICATION_URL` |
| `ai automation communication` frontend | `3002` | launch target from `/communication/launch` |
| `web-agency-backend-api` | `3500` | gateway itself |

## Response Envelope

The gateway injects metadata into most JSON responses:

```json
{
  "success": true,
  "message": "Human-readable message",
  "data": {},
  "timestamp": "2026-04-28T12:00:00.000Z",
  "requestId": "...",
  "statusCode": 200,
  "status": "success"
}
```

Error example:

```json
{
  "success": false,
  "message": "Payment service is not configured on this server.",
  "timestamp": "2026-04-28T12:00:00.000Z",
  "requestId": "...",
  "statusCode": 503,
  "status": "error"
}
```

## Authentication Model

### Public routes

No bearer token required.

### Protected routes

Send:

```http
Authorization: Bearer <accessToken>
```

The gateway verifies access tokens locally with `JWT_ACCESS_SECRET` and also forwards the same bearer token to proxied IAM, payment, and AI Communication endpoints when required.

### Tenant header

For public tenant-scoped routes, send:

```http
x-tenant-id: easydev
```

If the client omits it and `TENANT_ID` is configured on the gateway, the gateway injects its fallback tenant automatically.

## System Routes

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | local service health |
| `GET` | `/ready` | MongoDB readiness check |
| `GET` | `/platform-health` | aggregated upstream status |
| `GET` | `/postman-collection` | returns the Postman collection file |

## IAM Proxy Surface

These prefixes are forwarded to IAM:

| Gateway prefix | IAM target prefix |
|---|---|
| `/auth/*` | `/api/v1/iam/auth/*` |
| `/rbac/*` | `/api/v1/iam/rbac/*` |
| `/users/*` | `/api/v1/iam/users/*` |
| `/tenants/*` | `/api/v1/iam/tenants/*` |
| `/sessions/*` | `/api/v1/iam/sessions/*` |
| `/iam/health` | `/api/v1/iam/health` |
| `/iam/logs/*` | `/api/v1/iam/logs/*` |
| `/iam/stats/*` | `/api/v1/iam/stats/*` |
| `/iam/security/*` | `/api/v1/iam/security/*` |
| `/iam/api-keys/*` | `/api/v1/iam/api-keys/*` |
| `/iam/webhooks/*` | `/api/v1/iam/webhooks/*` |
| `/iam/flags/*` | `/api/v1/iam/feature-flags/*` |
| `/iam/apps/*` | `/api/v1/iam/apps/*` |
| `/iam/settings/*` | `/api/v1/iam/settings/*` |
| `/admin/*` | legacy alias to IAM users routes |

Supported auth calls for new clients:

- `POST /auth/register`
- `POST /auth/register/send-verification`
- `POST /auth/register/verify`
- `POST /auth/check`
- `POST /auth/login`
- `POST /auth/logout`
- `POST /auth/logout-all`
- `POST /auth/refresh`
- `GET /auth/me`
- `POST /auth/otp/send`
- `POST /auth/otp/verify`
- `POST /auth/magic-link/send`
- `POST /auth/magic-link/verify`
- `POST /auth/password/forgot`
- `POST /auth/password/reset`
- `POST /auth/password/change`
- `POST /auth/password/bootstrap-change`
- `POST /auth/social/login`
- `POST /auth/social/link`
- `DELETE /auth/social/unlink/:provider`
- `GET /auth/social/accounts`
- `GET /auth/social/:provider`
- `GET /auth/social/:provider/callback`

Avoid for new integrations:

- `GET /auth/token/verify`

That path is still present in some client helpers but is not implemented by the current IAM controller.

## Leads API

The lead module is owned by this repo.

### Public routes

| Method | Path | Notes |
|---|---|---|
| `GET` | `/leads/health` | module health |
| `POST` | `/leads/submit` | public submit, requires `x-tenant-id` |
| `GET` | `/leads/:id/proposal/view/:version` | public proposal view tracking |

Public submit example:

```http
POST /api/leads/submit
x-tenant-id: easydev
Content-Type: application/json

{
  "firstName": "Jane",
  "lastName": "Doe",
  "email": "jane@example.com",
  "phone": "+15550100",
  "subject": "Website redesign",
  "message": "We need a full redesign and maintenance plan.",
  "gdprConsent": true,
  "category": "Sales",
  "projectType": "redesign",
  "budget": "10k-25k",
  "timeline": "2-3months",
  "preferredContactMethod": "email",
  "website": "https://example.com"
}
```

### Authenticated routes

| Method | Path |
|---|---|
| `GET` | `/leads/stats` |
| `GET` | `/leads/proposals/stats` |
| `GET` | `/leads/proposals/expiring` |
| `GET` | `/leads` |
| `GET` | `/leads/export` |
| `GET` | `/leads/search` |
| `GET` | `/leads/follow-up` |
| `POST` | `/leads/bulk-update` |
| `POST` | `/leads/bulk-delete` |
| `POST` | `/leads/import` |
| `GET` | `/leads/spam` |
| `POST` | `/leads/proposals/expire-check` |
| `GET` | `/leads/:id` |
| `PATCH` | `/leads/:id` |
| `DELETE` | `/leads/:id` |
| `GET` | `/leads/:id/score` |
| `POST` | `/leads/:id/notes` |
| `POST` | `/leads/:id/contact` |
| `POST` | `/leads/:id/proposal` |
| `POST` | `/leads/:id/proposal/resend` |
| `POST` | `/leads/:id/proposal/revise` |
| `PATCH` | `/leads/:id/proposal/accept` |
| `PATCH` | `/leads/:id/proposal/decline` |
| `GET` | `/leads/:id/proposal/history` |
| `GET` | `/leads/:id/proposal/:version` |
| `POST` | `/leads/:id/contract` |
| `PATCH` | `/leads/:id/contract/signed` |
| `PATCH` | `/leads/:id/status` |
| `PATCH` | `/leads/:id/hold` |
| `PATCH` | `/leads/:id/reopen` |
| `PATCH` | `/leads/:id/won` |
| `PATCH` | `/leads/:id/lost` |
| `POST` | `/leads/:id/attachments` |
| `DELETE` | `/leads/:id/attachments/:fileId` |
| `PATCH` | `/leads/:id/spam` |
| `DELETE` | `/leads/:id/hard-delete` |
| `PATCH` | `/leads/:id/reopen-admin` |

## Newsletter API

Newsletter is MongoDB-backed and owned by this repo.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/newsletter/subscribe` | creates a pending subscriber or reactivates an inactive one |
| `GET` | `/newsletter/confirm/:token` | confirms double opt-in |
| `POST` | `/newsletter/unsubscribe` | soft unsubscribe |
| `GET` | `/newsletter/subscribers` | admin only |
| `GET` | `/newsletter/stats` | admin only |
| `GET` | `/newsletter/subscriber/:id` | admin only |
| `PATCH` | `/newsletter/subscriber/:id/tags` | admin only |
| `POST` | `/newsletter/track/open` | tracking pixel helper |
| `POST` | `/newsletter/track/click` | click tracking helper |
| `DELETE` | `/newsletter/subscriber/:id` | admin only soft delete |

Subscribe example:

```http
POST /api/newsletter/subscribe
Content-Type: application/json

{
  "email": "reader@example.com",
  "name": "Reader",
  "preferences": ["updates", "offers"]
}
```

## Payments API

The payment module is an adapter over `payment-microservice`.

### Public checkout routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/payments/methods` | list enabled checkout providers |
| `POST` | `/payments/initiate` | create a provider checkout order |
| `POST` | `/payments/verify` | verify payment and trigger provisioning |
| `POST` | `/payments/webhooks/razorpay` | raw webhook forwarder |
| `POST` | `/payments/webhooks/stripe` | raw webhook forwarder |

Initiate example:

```http
POST /api/payments/initiate
Content-Type: application/json
x-tenant-id: easydev

{
  "provider": "RAZORPAY",
  "productId": "easydev-communication",
  "planKey": "growth",
  "customerEmail": "buyer@example.com"
}
```

Verify example:

```http
POST /api/payments/verify
Content-Type: application/json
x-tenant-id: easydev

{
  "provider": "RAZORPAY",
  "productId": "easydev-communication",
  "token": "order_or_reference_code",
  "paymentId": "pay_123",
  "signature": "razorpay_signature",
  "planKey": "growth",
  "name": "Jane Buyer",
  "email": "buyer@example.com",
  "businessName": "Buyer Co",
  "externalId": "crm_123"
}
```

### Authenticated customer billing routes

| Method | Path |
|---|---|
| `GET` | `/payments/subscriptions` |
| `GET` | `/payments/internal/products/:productId/current` | service-to-service helper |
| `GET` | `/payments/invoices` |
| `GET` | `/payments/payment-methods` |
| `POST` | `/payments/payment-methods/setup-intent` |
| `POST` | `/payments/payment-methods/setup-intents/:setupIntentId/complete` |
| `PATCH` | `/payments/payment-methods/:paymentMethodId/default` |
| `DELETE` | `/payments/subscriptions/:id` |
| `PATCH` | `/payments/subscriptions/:id/plan` |

### Admin billing routes

| Method | Path |
|---|---|
| `GET` | `/payments/admin/stats` |
| `GET` | `/payments/admin/transactions` |
| `GET` | `/payments/admin/subscriptions` |

## AI Communication Routes

### Gateway-owned communication routes

| Method | Path | Notes |
|---|---|---|
| `POST` | `/communication/provision` | public gateway wrapper over product provisioning |
| `GET` | `/communication/launch` | authenticated IAM SSO launch helper |
| `GET` | `/communication/admin/providers` | proxy to AI Communication admin API |
| `GET` | `/communication/admin/providers/health` | provider health summary |
| `PATCH` | `/communication/admin/providers/:id` | update provider |
| `PATCH` | `/communication/admin/providers/:id/toggle` | enable or disable provider |

Provision example:

```http
POST /api/communication/provision
Content-Type: application/json

{
  "name": "Jane Buyer",
  "email": "buyer@example.com",
  "planKey": "growth",
  "paymentId": "pay_123",
  "businessName": "Buyer Co",
  "externalId": "crm_123"
}
```

Launch example:

```http
GET /api/communication/launch?slug=easydev-ai-communication
Authorization: Bearer <accessToken>
```

Successful response:

```json
{
  "success": true,
  "message": "SSO launch URL generated",
  "data": {
    "launchUrl": "http://localhost:3002/sso?token=...&appId=...",
    "expiresIn": 300
  }
}
```

### Customer product proxy routes

The gateway forwards `/customer/*` to AI Communication. Commonly used paths include:

| Method | Path |
|---|---|
| `GET` | `/customer/business` |
| `GET` | `/customer/business/stats` |
| `GET` | `/customer/business/usage` |
| `PATCH` | `/customer/business/pay-as-you-go` |
| `PATCH` | `/customer/business/auto-reply` |
| `PATCH` | `/customer/business/test-mode` |
| `GET` | `/customer/conversations` |
| `GET` | `/customer/conversations/stats` |
| `GET` | `/customer/messages/stats` |
| `GET` | `/customer/ai-config` |
| `PUT` | `/customer/ai-config` |
| `DELETE` | `/customer/ai-config/faqs/:faqId` |
| `GET` | `/customer/users` |
| `GET` | `/customer/email-accounts` |
| `POST` | `/customer/email-accounts` |
| `PATCH` | `/customer/email-accounts/:id` |
| `DELETE` | `/customer/email-accounts/:id` |
| `POST` | `/customer/email-accounts/:id/test-smtp` |
| `POST` | `/customer/email-accounts/:id/sync-now` |

### Normalized customer channel helper routes

The gateway normalizes a simpler channel contract on top of AI Communication:

| Method | Path | Notes |
|---|---|---|
| `GET` | `/customer/channels` | returns simplified `type`, `identifier`, `displayName`, `status` |
| `POST` | `/customer/channels` | accepts `type`, `identifier`, `displayName` |
| `DELETE` | `/customer/channels/:id` | removes channel |

Create channel example:

```http
POST /api/customer/channels
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "type": "email",
  "identifier": "support@example.com",
  "displayName": "Support Inbox"
}
```

## File Routes

`/files/*` is proxied to the file upload service.

Common paths:

| Method | Path |
|---|---|
| `POST` | `/files/upload` |
| `GET` | `/files` |
| `GET` | `/files/:id` |
| `GET` | `/files/:id/download` |
| `PATCH` | `/files/:id/rename` |
| `PATCH` | `/files/:id` |
| `PUT` | `/files/:id/replace` |
| `DELETE` | `/files/:id` |
| `DELETE` | `/files/:id/permanent` |
| `GET` | `/files/:id/transactions` |

## Proposal Upload Route

The gateway-owned proposal upload contract is:

```http
POST /api/upload/proposal
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "fileName": "proposal-acme.html",
  "mimeType": "text/html",
  "contentBase64": "PGh0bWw+Li4uPC9odG1sPg=="
}
```

Response:

```json
{
  "success": true,
  "message": "Proposal file uploaded successfully",
  "data": {
    "fileName": "proposal-acme.html",
    "mimeType": "text/html",
    "url": "http://localhost:3500/uploads/proposals/proposal-acme.html"
  }
}
```

## Calculator Routes

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/calculator/estimate` | return project, maintenance, server, and TCO estimates |
| `GET` | `/calculator/profiles` | return supported project profiles and server tiers |

Estimate example:

```http
POST /api/calculator/estimate
Content-Type: application/json

{
  "amount": 50000,
  "currency": "INR",
  "projectType": "website",
  "complexityLevel": "standard",
  "projectName": "Business Website"
}
```

## Common Error Meanings

| Status | Meaning |
|---|---|
| `400` | validation or malformed payload |
| `401` | missing or invalid auth |
| `403` | authenticated but not authorized |
| `404` | missing resource or expired pending checkout record |
| `409` | business conflict, such as duplicate purchase |
| `429` | rate limit exceeded |
| `502` | upstream service responded with an integration failure |
| `503` | upstream service URL missing or service unavailable |

## End-To-End Flows

### Public purchase to product access

1. Frontend calls `GET /payments/methods`.
2. Frontend calls `POST /payments/initiate`.
3. Frontend completes provider checkout.
4. Frontend calls `POST /payments/verify`.
5. Gateway verifies payment with the payment microservice.
6. Gateway provisions AI Communication locally and in IAM.
7. User signs in through IAM via `/auth/login`.
8. Frontend calls `GET /communication/launch`.
9. Browser opens the returned AI Communication `launchUrl`.

### Existing member opens the product

1. Frontend restores session with `GET /auth/me`.
2. Frontend loads subscriptions with `GET /payments/subscriptions`.
3. Frontend calls `GET /communication/launch`.
4. AI Communication exchanges the SSO token for its product cookie session.

### Public lead capture

1. Frontend sends `POST /leads/submit` with `x-tenant-id`.
2. Gateway stores the lead in its local lead module.
3. Staff review and operate on that lead using authenticated `/leads/*` routes.

## Integration Notes

- New clients should not assume this repo exposes blog or plans CRUD routes. It does not.
- Use the gateway for all browser traffic even when the downstream service has its own public docs.
- If a gateway route returns `503`, inspect the matching upstream URL in the gateway environment before debugging the client.
