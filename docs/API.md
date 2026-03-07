# Web Agency Backend API — Documentation

## Table of Contents

1. [Overview](#1-overview)
2. [Base URL & Environments](#2-base-url--environments)
3. [Architecture — How Microservices Are Used](#3-architecture--how-microservices-are-used)
4. [Running the Service](#4-running-the-service)
5. [Environment Variables](#5-environment-variables)
6. [Authentication](#6-authentication)
7. [Request & Response Format](#7-request--response-format)
8. [Rate Limiting](#8-rate-limiting)
9. [Routes Reference](#9-routes-reference)
   - [System](#91-system)
   - [Auth — Public](#92-auth--public-proxied)
   - [Auth — Protected](#93-auth--protected-proxied)
   - [Admin](#94-admin-proxied)
   - [Leads / Contact & Inquiry Forms](#95-leads--contact--inquiry-forms-proxied)
   - [Files](#96-files-proxied)
   - [Newsletter](#97-newsletter-owned)
   - [Upload — Proposal HTML](#98-upload--proposal-html-owned)
10. [Error Codes](#10-error-codes)
11. [End-to-End Workflows](#11-end-to-end-workflows)
12. [Postman Collection](#12-postman-collection)

---

## 1. Overview

**web-agency-backend-api** is the public-facing API gateway for the web agency website. It serves as the **single base URL** for all frontend requests and either handles them directly or proxies them to the appropriate downstream microservice.

### What this service owns
| Area | Storage |
|---|---|
| Newsletter subscriptions (double opt-in lifecycle) | MongoDB |
| Proposal HTML file uploads (local disk) | Local filesystem |
| Health / readiness probes | In-memory |

### What this service proxies (no logic added)
| Traffic | Downstream service |
|---|---|
| Authentication, sessions, user profiles | **user-auth-service** |
| Contact forms, project inquiries, CRM pipeline | **lead-microservice** |
| File storage (cloud/S3/GCS) | **file-upload-service** |

---

## 2. Base URL & Environments

| Environment | Base URL |
|---|---|
| Local development | `http://localhost:3500` |
| Staging | `https://api-staging.yoursite.com` |
| Production | `https://api.yoursite.com` |

> All API endpoints are prefixed with `/api`.

---

## 3. Architecture — How Microservices Are Used

```
Browser / Mobile App
        │
        ▼ (single origin)
┌─────────────────────────────────────────────────┐
│         web-agency-backend-api  :3500            │
│                                                   │
│  Owned routes:                                    │
│    /api/newsletter/*   ──► MongoDB               │
│    /api/upload/*       ──► local disc             │
│    /api/health         ──► in-process             │
│                                                   │
│  Proxy routes (transparent pass-through):         │
│    /api/auth/*   ──────────────────────────────► user-auth-service :4002   │
│    /api/admin/*  ──────────────────────────────► user-auth-service :4002   │
│    /api/leads/*  ──────────────────────────────► lead-microservice         │
│    /api/files/*  ──────────────────────────────► file-upload-service :4001 │
└─────────────────────────────────────────────────┘
```

### Key design rules

- **Contact forms and project inquiries** both submit to `POST /api/leads/submit` on the lead-microservice. Use the `category` field to distinguish them. The lead-microservice owns all CRM pipeline logic, email notifications, and storage for leads.
- **JWT tokens are issued exclusively by user-auth-service.** This gateway only *verifies* tokens using the shared `JWT_ACCESS_SECRET`. It never creates or revokes tokens.
- **All outgoing email** goes through the email-microservice. This service never calls SMTP directly.
- **File persistence** for cloud/S3 storage goes through the file-upload-service (`/api/files/upload`). The only local files are proposal HTML pages under `/uploads/proposals/`.

---

## 4. Running the Service

### Prerequisites
- Node.js 18+
- pnpm (or npm/yarn)
- MongoDB instance (only needed for the newsletter feature)
- At least one downstream microservice running (or set their URL to trigger the 503 fallback gracefully)

### Install dependencies
```bash
pnpm install
```

### Start (development — with hot reload)
```bash
pnpm dev
```

### Start (production)
```bash
pnpm start
```

### Start (cluster mode — one worker per CPU)
```bash
pnpm start:cluster
```

### Port
Defaults to **3500**. Override with `PORT` env var.

---

## 5. Environment Variables

Create a `.env` file in the project root:

```env
# ── Service ────────────────────────────────────────────────
PORT=3500
NODE_ENV=development

# Frontend URL (used to build newsletter confirmation/unsubscribe links)
FRONTEND_URL=https://yoursite.com

# Comma-separated list of allowed CORS origins
CORS_ORIGINS=https://yoursite.com,https://admin.yoursite.com

# ── Database ───────────────────────────────────────────────
# Only required for the newsletter feature
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/web-agency

# ── JWT ────────────────────────────────────────────────────
# MUST match JWT_ACCESS_SECRET in the user-auth-service
JWT_ACCESS_SECRET=your-shared-secret-here
JWT_ISSUER=user-auth-service
JWT_AUDIENCE=dashboard-app

# ── Microservice URLs ──────────────────────────────────────
EMAIL_SERVICE_URL=http://localhost:4000
AUTH_SERVICE_URL=http://localhost:4002
LEAD_SERVICE_URL=http://localhost:4003
FILE_UPLOAD_SERVICE_URL=http://localhost:4001

# ── Admin ──────────────────────────────────────────────────
ADMIN_EMAIL=admin@yoursite.com

# ── Optional ───────────────────────────────────────────────
LOG_LEVEL=debug            # debug | info | warn | error
ENABLE_LOGGING=true
CLUSTER_MODE=false         # set true to use all CPU cores
REQUEST_TIMEOUT=30000      # ms
SHUTDOWN_TIMEOUT=10000     # ms
```

> If `AUTH_SERVICE_URL`, `LEAD_SERVICE_URL`, or `FILE_UPLOAD_SERVICE_URL` is not set, the corresponding proxy path returns a `503 Service Unavailable` gracefully instead of crashing.

---

## 6. Authentication

### How it works

1. The frontend calls `POST /api/auth/login` → receives `accessToken` + `refreshToken`.
2. The frontend includes `Authorization: Bearer <accessToken>` on every protected request.
3. This gateway verifies the token signature using `JWT_ACCESS_SECRET` (stateless — no DB lookup, no call to the auth service).
4. `req.user` is populated with `{ id, email, role, tenantId, sessionId }` from the token claims.
5. When the token expires (401 `Token has expired`), call `POST /api/auth/token/refresh`.

### Token claims
```json
{
  "sub": "<userId>",
  "email": "user@example.com",
  "role": "admin",
  "tenantId": "<tenantId>",
  "sessionId": "<sessionId>",
  "iss": "user-auth-service",
  "aud": "dashboard-app"
}
```

### Error responses
| Status | Message | Cause |
|---|---|---|
| `401` | `Access denied. No token provided` | Missing `Authorization` header |
| `401` | `Invalid token` | Malformed / wrong secret |
| `401` | `Token has expired` | Token past its expiry |

---

## 7. Request & Response Format

### Request headers for protected routes
```
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Standard response envelope
All responses (success and error) follow this shape:
```json
{
  "success": true,
  "message": "Human-readable message",
  "data": {}
}
```

### Error response
```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [
    { "field": "email", "message": "Please provide a valid email address" }
  ]
}
```

---

## 8. Rate Limiting

- **Limit:** 200 requests per minute per IP
- **Window:** 60 seconds
- **Excluded:** `GET /api/health`
- **Headers returned:** `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`
- **When exceeded (429):**
```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests from this IP. Please wait a moment and try again."
  }
}
```

---

## 9. Routes Reference

### 9.1 System

#### `GET /api/health`
Returns service status. No auth required.

**Response `200`:**
```json
{
  "success": true,
  "message": "Server is running successfully",
  "data": {
    "status": "healthy",
    "timestamp": "2026-03-07T10:00:00.000Z",
    "uptime": 3600,
    "environment": "development",
    "version": "1.0.0",
    "memory": { "heapUsed": "45MB", "heapTotal": "64MB", "rss": "80MB" },
    "pid": 12345
  }
}
```

---

#### `GET /api/ready`
Returns `200` only when MongoDB is connected. Use for load-balancer probes.

**Response `200`:** `{ "success": true, "message": "Service is ready" }`  
**Response `503`:** `{ "success": false, "message": "Service is not ready" }`

---

#### `GET /api/postman-collection`
Returns the Postman collection JSON file. Import directly into Postman.

---

### 9.2 Auth — Public (Proxied)

> **Proxied to:** `AUTH_SERVICE_URL/api/auth/*`  
> No authentication required.

#### `POST /api/auth/register`
Register a new user account.

**Body:**
```json
{
  "firstName": "Jane",
  "lastName": "Doe",
  "email": "jane.doe@example.com",
  "password": "Password123!"
}
```

---

#### `POST /api/auth/login`
Login. Returns access and refresh tokens.

**Body:**
```json
{
  "email": "jane.doe@example.com",
  "password": "Password123!"
}
```

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGc...",
    "refreshToken": "eyJhbGc..."
  }
}
```

---

#### `POST /api/auth/login/mfa`
Complete an MFA challenge after login.

**Body:** `{ "email": "...", "otpCode": "123456" }`

---

#### `POST /api/auth/token/refresh`
Exchange a refresh token for a new access token.

**Body:** `{ "refreshToken": "<refreshToken>" }`

---

#### `GET /api/auth/token/verify`
Verify whether the current bearer token is valid (uses collection-level auth).

---

#### `POST /api/auth/email/verify`
Verify email address using a one-time code.

**Body:** `{ "email": "...", "otp": "123456" }`

---

#### `POST /api/auth/email/resend`
Resend the email verification OTP.

**Body:** `{ "email": "..." }`

---

#### `POST /api/auth/password/forgot`
Request a password reset email.

**Body:** `{ "email": "..." }`

---

#### `POST /api/auth/password/reset`
Complete a password reset using the token from email.

**Body:** `{ "token": "reset-token-from-email", "newPassword": "NewPassword123!" }`

---

#### `POST /api/auth/otp/verify`
Verify an OTP code.

**Body:** `{ "email": "...", "otp": "123456" }`

---

#### `POST /api/auth/otp/resend`
Resend an OTP.

**Body:** `{ "email": "..." }`

---

#### `POST /api/auth/account/unlock/request`
Request an account unlock email after too many failed logins.

**Body:** `{ "email": "..." }`

---

#### `POST /api/auth/account/unlock/confirm`
Confirm account unlock using the token from the email.

**Body:** `{ "token": "unlock-token-from-email" }`

---

#### `POST /api/auth/social/login`
Login/register using a social OAuth provider.

**Body:** `{ "provider": "google", "idToken": "google-id-token" }`

---

### 9.3 Auth — Protected (Proxied)

> **Proxied to:** `AUTH_SERVICE_URL/api/auth/*`  
> Requires `Authorization: Bearer <accessToken>`

#### `GET /api/auth/me`
Returns the profile of the currently authenticated user.

---

#### `PATCH /api/auth/me`
Update profile fields.

**Body (all optional):**
```json
{
  "firstName": "Jane",
  "lastName": "Smith",
  "phone": "+1234567890"
}
```

---

#### `POST /api/auth/password/change`
Change password while logged in.

**Body:** `{ "currentPassword": "...", "newPassword": "..." }`

---

#### `POST /api/auth/logout`
Revoke the current session and invalidate both tokens.

---

#### `GET /api/auth/social/accounts`
List all OAuth providers linked to the current account.

---

#### `POST /api/auth/social/link`
Link a new social provider to the current account.

**Body:** `{ "provider": "github", "idToken": "..." }`

---

#### `DELETE /api/auth/social/unlink/:provider`
Unlink a social provider. `:provider` = `google` | `github` | `facebook`

---

### 9.4 Admin (Proxied)

> **Proxied to:** `AUTH_SERVICE_URL/api/admin/*`  
> Requires Bearer token with `role: admin` or `role: super_admin`

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/admin/users/:userId/unlock` | Force-unlock a locked user account |
| `GET` | `/api/admin/sessions` | List all active sessions |
| `DELETE` | `/api/admin/sessions/:sessionId` | Force-revoke a specific session |
| `GET` | `/api/admin/logs` | View authentication activity logs |
| `GET` | `/api/admin/analytics` | View authentication analytics |

---

### 9.5 Leads / Contact & Inquiry Forms (Proxied)

> **Proxied to:** `LEAD_SERVICE_URL/api/leads/*`  
> Public submit requires `x-tenant-id` header. Admin routes require Bearer token.

**Contact forms and project inquiries use the same endpoint.** The `category` field distinguishes them:

| Form type | `category` value | Extra fields |
|---|---|---|
| General contact message | `General Inquiry` | — |
| Project estimate / inquiry | `Sales` | `projectType`, `budget`, `timeline` |

#### `POST /api/leads/submit` — Public
Submit a contact form or project inquiry.

**Required header:** `x-tenant-id: <your-tenant-id>`

**Body:**
```json
{
  "firstName": "John",
  "lastName": "Smith",
  "email": "john.smith@example.com",
  "subject": "Website enquiry",
  "message": "I'd like to know more about your services.",
  "gdprConsent": true,
  "category": "General Inquiry",

  "phone": "+1234567890",
  "preferredContactMethod": "email"
}
```

**Body — Project Inquiry (same endpoint, different fields):**
```json
{
  "firstName": "Sarah",
  "lastName": "Johnson",
  "email": "sarah@acme.com",
  "subject": "E-commerce platform",
  "message": "We need a full e-commerce site built from scratch.",
  "gdprConsent": true,
  "category": "Sales",

  "phone": "+1987654321",
  "projectType": "ecommerce",
  "budget": "25k-50k",
  "timeline": "3-6months",
  "website": "https://acme.com",
  "preferredContactMethod": "email"
}
```

**`projectType` values:** `website` | `webapp` | `mobile` | `ecommerce` | `redesign` | `maintenance` | `consulting` | `other`  
**`budget` values:** `under-5k` | `5k-10k` | `10k-25k` | `25k-50k` | `50k-100k` | `over-100k` | `not-sure`  
**`timeline` values:** `asap` | `1-month` | `2-3months` | `3-6months` | `6months+` | `flexible`

---

#### Admin CRM routes (require Bearer token)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/leads` | List leads with filters (`status`, `assignedTo`, `page`, `limit`) |
| `GET` | `/api/leads/stats` | Pipeline statistics |
| `GET` | `/api/leads/search?q=` | Full-text search |
| `GET` | `/api/leads/export` | Export to CSV |
| `GET` | `/api/leads/follow-up` | Leads due for follow-up |
| `POST` | `/api/leads/bulk-update` | Bulk status/assignment update |
| `POST` | `/api/leads/import` | Import from CSV |
| `GET` | `/api/leads/:id` | Get a single lead |
| `PATCH` | `/api/leads/:id` | Update lead fields |
| `DELETE` | `/api/leads/:id` | Soft-delete lead |
| `POST` | `/api/leads/:id/notes` | Add internal note |
| `POST` | `/api/leads/:id/contact` | Log a contact attempt |
| `PATCH` | `/api/leads/:id/status` | Change pipeline status |
| `PATCH` | `/api/leads/:id/won` | Mark as won |
| `PATCH` | `/api/leads/:id/lost` | Mark as lost |
| `PATCH` | `/api/leads/:id/hold` | Put on hold |
| `POST` | `/api/leads/:id/proposal` | Send proposal (requires `proposalUrl`) |
| `POST` | `/api/leads/:id/proposal/resend` | Resend proposal |
| `POST` | `/api/leads/:id/proposal/revise` | Revise proposal |
| `PATCH` | `/api/leads/:id/proposal/accept` | Mark proposal accepted |
| `PATCH` | `/api/leads/:id/proposal/decline` | Mark proposal declined |
| `POST` | `/api/leads/:id/contract` | Send contract |
| `PATCH` | `/api/leads/:id/contract/signed` | Mark contract signed |
| `POST` | `/api/leads/:id/attachments` | Register a file URL as an attachment |
| `DELETE` | `/api/leads/:id/attachments/:fileId` | Remove an attachment |

---

### 9.6 Files (Proxied)

> **Proxied to:** `FILE_UPLOAD_SERVICE_URL/api/files/*`  
> Requires Bearer token.  
> Pass these additional headers from your JWT claims:

```
X-Tenant-Id: <tenantId from token>
X-User-Id:   <sub from token>
X-User-Role: <role from token>
```

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/files/upload` | Upload up to 10 files (multipart/form-data, field name: `files`) |
| `GET` | `/api/files` | List files with filters |
| `GET` | `/api/files/:id` | Get file metadata |
| `GET` | `/api/files/:id/download` | Download file content |
| `PATCH` | `/api/files/:id/rename` | Rename file — body: `{ "name": "new-name.pdf" }` |
| `PATCH` | `/api/files/:id` | Update file metadata |
| `PUT` | `/api/files/:id/replace` | Replace file content |
| `DELETE` | `/api/files/:id` | Soft-delete |
| `DELETE` | `/api/files/:id/permanent` | Permanent delete |
| `GET` | `/api/files/:id/transactions` | File change history |

**Upload example (multipart):**
```
POST /api/files/upload
Authorization: Bearer <token>
X-Tenant-Id: abc123
X-User-Id: user456
X-User-Role: admin
Content-Type: multipart/form-data

files: <binary file data>
```

---

### 9.7 Newsletter (Owned)

> **Backed by MongoDB.** This service owns the full newsletter lifecycle.  
> Public routes: subscribe, confirm, unsubscribe.  
> Admin routes require Bearer token.

---

#### `POST /api/newsletter/subscribe` — Public
Subscribe to the newsletter. Triggers a **double opt-in** confirmation email.

- If the email already exists and is **active** → returns `200` (no duplicate).
- If the email exists but is **inactive** → reactivates and sends a re-subscribe welcome email.
- If new → creates record, sends confirmation email.

**Body:**
```json
{
  "email": "user@example.com",
  "name": "Jane Doe",
  "preferences": ["updates", "promotions"]
}
```

**Response `201`:**
```json
{
  "success": true,
  "message": "Please check your email to confirm your subscription",
  "data": {
    "email": "user@example.com",
    "requiresConfirmation": true
  }
}
```

---

#### `GET /api/newsletter/confirm/:token` — Public
Confirm the subscription using the token from the opt-in email. Sends a welcome email on first confirmation.

**Example:** `GET /api/newsletter/confirm/abc123token`

**Response `200`:**
```json
{
  "success": true,
  "message": "Your subscription has been confirmed. Thank you!"
}
```

---

#### `POST /api/newsletter/unsubscribe` — Public
Unsubscribe from the newsletter. Sends a farewell email.

**Body:**
```json
{
  "email": "user@example.com",
  "reason": "no_longer_interested",
  "feedback": "Too many emails"
}
```

---

#### `GET /api/newsletter/subscribers` — Admin
List all subscribers with pagination and filters.

**Query params:**
| Param | Type | Description |
|---|---|---|
| `page` | number | Page number (default: 1) |
| `limit` | number | Results per page (default: 20) |
| `isActive` | boolean | Filter by active status |
| `isConfirmed` | boolean | Filter by confirmation status |
| `search` | string | Search by email or name |
| `tag` | string | Filter by tag |

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "subscribers": [...],
    "pagination": {
      "total": 250,
      "page": 1,
      "limit": 20,
      "pages": 13
    }
  }
}
```

---

#### `GET /api/newsletter/stats` — Admin
Returns total, active, confirmed, unsubscribed counts plus last 30-day growth.

---

#### `GET /api/newsletter/subscriber/:id` — Admin
Get a single subscriber by MongoDB ID.

---

#### `PATCH /api/newsletter/subscriber/:id/tags` — Admin
Update tags on a subscriber.

**Body:** `{ "tags": ["vip", "enterprise"] }`

---

### 9.8 Upload — Proposal HTML (Owned)

> Requires Bearer token.  
> Saves a base64-encoded HTML file to `uploads/proposals/` on-disk and returns a public URL.

#### `POST /api/upload/proposal`

**Body:**
```json
{
  "fileName": "proposal-acme-2026.html",
  "mimeType": "text/html",
  "contentBase64": "<base64-encoded HTML string>"
}
```

> `contentBase64` can optionally include a data URL prefix (`data:text/html;base64,...`) — the prefix will be stripped automatically.

**Response `201`:**
```json
{
  "success": true,
  "message": "Proposal file uploaded successfully",
  "data": {
    "fileName": "proposal-acme-2026.html",
    "mimeType": "text/html",
    "url": "http://localhost:3500/uploads/proposals/proposal-acme-2026.html"
  }
}
```

> The returned `url` can be passed to `POST /api/leads/:id/proposal` to send the proposal to the client.

---

## 10. Error Codes

| HTTP Status | Meaning |
|---|---|
| `400` | Bad request — validation failed or missing required fields |
| `401` | Unauthenticated — no token, invalid token, or expired token |
| `403` | Forbidden — authenticated but insufficient role |
| `404` | Resource not found |
| `409` | Conflict — e.g. duplicate email |
| `422` | Unprocessable entity — business rule violation |
| `429` | Rate limit exceeded |
| `500` | Internal server error |
| `502` | Upstream microservice returned an error |
| `503` | Upstream microservice is unreachable or its URL is not configured |

All error responses follow:
```json
{
  "success": false,
  "message": "Human-readable error message",
  "errors": [ { "field": "email", "message": "..." } ]
}
```

---

## 11. End-to-End Workflows

### Workflow 1 — Website contact form
```
1. User fills out contact form on website
2. Frontend POSTs to: POST /api/leads/submit
   Headers: x-tenant-id: <tenantId>
   Body: { firstName, lastName, email, subject, message, gdprConsent: true, category: "General Inquiry" }
3. Gateway proxies the request to lead-microservice
4. lead-microservice stores the lead, sends notification email to admin, sends acknowledgement to user
5. Admin views the lead in the CRM dashboard via GET /api/leads
```

### Workflow 2 — Project inquiry form
```
1. User fills out the "Get a Quote" form
2. Frontend POSTs to: POST /api/leads/submit
   Body: { ..., category: "Sales", projectType: "ecommerce", budget: "25k-50k", timeline: "3-6months" }
3. Same submit endpoint — lead-microservice handles all CRM stages from here
```

### Workflow 3 — Sending a proposal
```
1. Admin generates a proposal HTML page
2. POST /api/upload/proposal  →  { url: "http://localhost:3500/uploads/proposals/acme.html" }
3. POST /api/leads/:id/proposal  →  { proposalUrl: "<url from step 2>", quotedAmount: 12000, quotedCurrency: "USD" }
4. lead-microservice emails the proposal link to the client
```

### Workflow 4 — Newsletter subscribe + confirm
```
1. Visitor enters email on website
2. POST /api/newsletter/subscribe  →  201 "Please check your email to confirm"
3. User clicks confirmation link in email (link contains token)
4. GET /api/newsletter/confirm/:token  →  200 "Confirmed"
5. Welcome email is sent to subscriber
```

### Workflow 5 — User login and protected request
```
1. POST /api/auth/login  →  { accessToken, refreshToken }
2. Store accessToken in memory (or httpOnly cookie)
3. All protected requests:  Authorization: Bearer <accessToken>
4. When 401 "Token has expired":
   POST /api/auth/token/refresh  →  { accessToken: "<new token>" }
```

### Workflow 6 — File attachment on a lead
```
1. POST /api/files/upload  (multipart, with X-Tenant-Id, X-User-Id, X-User-Role headers)
   →  { data: { files: [{ _id: "file123", url: "..." }] } }
2. POST /api/leads/:id/attachments  →  { fileUrl: "...", fileName: "...", fileType: "..." }
```

---

## 12. Postman Collection

The full Postman collection is available two ways:

**Option A — Download from the running service:**
```
GET http://localhost:3500/api/postman-collection
```
Open Postman → Import → Link → paste the URL above.

**Option B — Import the file directly:**
The file is at `postman/Web-Agency-API.postman_collection.json` in this repository.

### Collection variables
| Variable | Description |
|---|---|
| `baseUrl` | `http://localhost:3500` — change for staging/production |
| `authToken` | Auto-filled by the Login request test script |
| `refreshToken` | Auto-filled by the Login request test script |
| `leadId` | Auto-filled after submitting a lead |
| `fileId` | Auto-filled after uploading a file |
| `subscriberEmail` | Email used in newsletter tests |

> After running **Login**, all subsequent protected requests automatically inherit `{{authToken}}`.
