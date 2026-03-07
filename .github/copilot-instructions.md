# Web Agency Backend API — Copilot Instructions

## Service Overview

This is the **web-agency-backend** service — the main public-facing API for the web agency website. It handles:
- **Contact form** submissions (`/api/contact`)
- **Project inquiries** (`/api/inquiry`)
- **Newsletter** subscriptions with email-microservice integration (`/api/newsletter`)
- **Proposal file uploads** (`/api/upload`)

---

## Microservice Architecture

This service depends on three external microservices. **Never duplicate their responsibilities here.**

### 1. user-auth-service (Port: 4002)
Source: `../user-auth-service`

Issues and owns all JWT access tokens. Routes are mounted at `/api/auth/...`.

**Key routes (call these from the frontend, never proxy them here):**
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register` | New user registration |
| POST | `/api/auth/login` | Login, returns `accessToken` + `refreshToken` |
| POST | `/api/auth/login/mfa` | Complete MFA login step |
| POST | `/api/auth/token/refresh` | Refresh access token |
| GET/POST | `/api/auth/token/verify` | Verify token validity |
| POST | `/api/auth/email/verify` | Verify email with OTP |
| POST | `/api/auth/email/resend` | Resend verification OTP |
| POST | `/api/auth/password/forgot` | Request password reset |
| POST | `/api/auth/password/reset` | Complete password reset |
| POST | `/api/auth/password/change` | Change password (auth required) |
| POST | `/api/auth/otp/verify` | Verify OTP code |
| POST | `/api/auth/otp/resend` | Resend OTP |
| POST | `/api/auth/logout` | Logout + revoke token |
| POST | `/api/auth/account/unlock/request` | Request account unlock |
| POST | `/api/auth/account/unlock/confirm` | Confirm account unlock |
| GET | `/api/auth/me` | Get own profile (auth required) |
| PATCH | `/api/auth/me` | Update own profile (auth required) |
| POST | `/api/auth/social/login` | Social OAuth login |
| GET | `/api/auth/social/accounts` | List linked social accounts (auth required) |
| POST | `/api/auth/social/link` | Link a social account (auth required) |
| DELETE | `/api/auth/social/unlink/:provider` | Unlink a social account (auth required) |

**Admin-only routes** (role: `admin` or `super_admin`):
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/admin/users/:userId/unlock` | Force-unlock a user account |
| GET | `/api/admin/sessions` | List all active sessions |
| DELETE | `/api/admin/sessions/:sessionId` | Force-revoke a session |
| GET | `/api/admin/logs` | View auth activity logs |
| GET | `/api/admin/analytics` | Auth analytics |

**JWT Token claims** (access token payload):
```json
{
  "sub": "<userId>",
  "email": "user@example.com",
  "role": "admin",
  "tenantId": "<tenantId>",
  "sessionId": "<sessionId>",
  "jti": "<uuid>",
  "iss": "user-auth-service",
  "aud": "dashboard-app"
}
```

**`middleware/auth.js` in this repo** verifies with `JWT_ACCESS_SECRET` (shared secret) and checks `issuer`/`audience` claims. It maps the decoded payload to `req.user = { id, email, role, tenantId, sessionId }`. **No DB lookup. Never issue or sign tokens here.**

---

### 2. lead-microservice (Port: configurable via `LEAD_SERVICE_URL`)
Source: `../lead-microservice`

Owns the full CRM / sales pipeline lifecycle.

**Key routes:**
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/leads/submit` | Public | Submit a lead (requires `x-tenant-id` header) |
| GET | `/api/leads` | ✓ | List leads with filtering/pagination |
| GET | `/api/leads/stats` | ✓ | Pipeline statistics |
| GET | `/api/leads/search` | ✓ | Full-text search |
| GET | `/api/leads/export` | ✓ | Export to CSV |
| GET | `/api/leads/follow-up` | ✓ | Leads due for follow-up |
| POST | `/api/leads/bulk-update` | ✓ | Bulk status/assignment update |
| POST | `/api/leads/import` | ✓ | CSV import |
| GET | `/api/leads/:id` | ✓ | Get single lead |
| PATCH | `/api/leads/:id` | ✓ | Update lead |
| DELETE | `/api/leads/:id` | ✓ | Soft delete |
| POST | `/api/leads/:id/notes` | ✓ | Add internal note |
| POST | `/api/leads/:id/contact` | ✓ | Log contact attempt |
| PATCH | `/api/leads/:id/status` | ✓ | Change pipeline status |
| PATCH | `/api/leads/:id/won` | ✓ | Mark as won |
| PATCH | `/api/leads/:id/lost` | ✓ | Mark as lost |
| PATCH | `/api/leads/:id/hold` | ✓ | Put on hold |
| POST | `/api/leads/:id/proposal` | ✓ | Send proposal |
| POST | `/api/leads/:id/proposal/resend` | ✓ | Resend proposal |
| POST | `/api/leads/:id/proposal/revise` | ✓ | Revise proposal |
| PATCH | `/api/leads/:id/proposal/accept` | ✓ | Mark proposal accepted |
| PATCH | `/api/leads/:id/proposal/decline` | ✓ | Mark proposal declined |
| POST | `/api/leads/:id/contract` | ✓ | Send contract |
| PATCH | `/api/leads/:id/contract/signed` | ✓ | Mark contract signed |
| POST | `/api/leads/:id/attachments` | ✓ | Register file attachment (URL from file-upload-service) |
| DELETE | `/api/leads/:id/attachments/:fileId` | ✓ | Remove attachment |

**`POST /api/leads/submit` payload:**
```json
{
  "firstName": "string (required)",
  "lastName": "string (required)",
  "email": "valid email (required)",
  "subject": "string (required, max 200)",
  "message": "string (required, max 5000)",
  "phone": "string (optional)",
  "gdprConsent": true,
  "budget": "under-5k|5k-10k|10k-25k|25k-50k|50k-100k|over-100k|not-sure (optional)",
  "timeline": "asap|1-month|2-3months|3-6months|6months+|flexible (optional)",
  "projectType": "website|webapp|mobile|ecommerce|redesign|maintenance|consulting|other (optional)",
  "category": "General Inquiry|Technical Support|Sales|Partnership|Feedback|Career|Other (optional)",
  "preferredContactMethod": "email|phone|whatsapp|any (optional)",
  "website": "URL (optional)",
  "customFields": {} 
}
```

**Never replicate** lead scoring, pipeline stages, proposal/contract logic, or CRM models in this repo.

---

### 3. Email Microservice (URL via `EMAIL_SERVICE_URL`)

All outgoing transactional emails must go through the email microservice via `utils/email.js` helpers. **Never use `nodemailer` directly.**

Payload format: `{ to, templateId, data: { ...templateVariables } }`

---

### 4. file-upload-service (Port: 4001, URL via `FILE_UPLOAD_SERVICE_URL`)
Source: `../file-upload-service`

Handles all file storage (local/S3/GCS/Azure/R2). When a proposal or attachment needs to be stored in the cloud, upload it here first, then register the returned URL.

**Key routes (`/api/files/...`):**
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/files/upload` | Upload up to 10 files (multipart) |
| GET | `/api/files` | List files with filters |
| GET | `/api/files/:id` | Get file metadata |
| GET | `/api/files/:id/download` | Download file |
| PATCH | `/api/files/:id/rename` | Rename file |
| PATCH | `/api/files/:id` | Update file metadata |
| PUT | `/api/files/:id/replace` | Replace file content |
| DELETE | `/api/files/:id` | Soft delete |
| DELETE | `/api/files/:id/permanent` | Permanent delete |
| GET | `/api/files/:id/transactions` | File history |

**Required headers:** `X-Tenant-Id`, `X-User-Id`, `X-User-Role` (pass values from `req.user`).

**Never store files directly in this service.** The `uploads/` directory in this repo is only for temporary local proposal HTML files served via `/uploads/proposals/...`.

---

## Email Template IDs

Use these exact `templateId` strings when calling the email microservice:

| Action | `templateId` | Key `data` fields |
|---|---|---|
| Contact form received (admin) | `CONTACT_NOTIFICATION` | `name, email, phone, company, subject, message, submittedAt, contactId` |
| Contact form auto-reply (user) | `CONTACT_CONFIRMATION` | `name, subject, companyName, contactId` |
| Inquiry received (admin) | `INQUIRY_NOTIFICATION` | `name, email, phone, company, projectType, budget, timeline, description, requirements, submittedAt, inquiryId, inquiryNumber` |
| Inquiry auto-reply (user) | `INQUIRY_CONFIRMATION` | `name, projectType, budget, timeline, companyName, inquiryId, inquiryNumber` |
| Newsletter double opt-in confirm | `NEWSLETTER_SUBSCRIBE_CONFIRMATION` | `name, email, confirmationUrl, companyName` |
| Newsletter welcome (post-confirm) | `NEWSLETTER_WELCOME` | `name, email, companyName, unsubscribeUrl` |
| Newsletter re-subscribe welcome | `NEWSLETTER_RESUBSCRIBE` | `name, email, companyName, unsubscribeUrl` |
| Newsletter farewell (unsubscribe) | `NEWSLETTER_FAREWELL` | `name, email, companyName` |
| Project proposal sent | `PROJECT_PROPOSAL_EMAIL` | `name, email, company, projectType, budget, timeline, inquiryId, inquiryNumber, proposalUrl, quotedAmount, quotedCurrency` |

---

## What NOT to Add

| Feature | Reason |
|---|---|
| Blog / CMS routes | Handled by a dedicated content service — do not add `/api/blogs` |
| Pricing / Plans routes | Handled separately — do not add `/api/plans` |
| Admin user management (create/list users) | Owned by user-auth-service |
| Local login, registration, or token endpoints | Owned by user-auth-service |
| Direct `nodemailer` usage | All email goes through the email microservice |
| Lead pipeline / CRM / proposal logic | Owned by lead-microservice |
| File storage to disk/cloud | Owned by file-upload-service |
| Token revocation lists | Owned by user-auth-service |

---

## Environment Variables

```env
# Service
PORT=3500
NODE_ENV=development
FRONTEND_URL=https://yoursite.com
CORS_ORIGINS=https://yoursite.com,https://admin.yoursite.com

# Database (only for contact, inquiry, newsletter, upload data)
MONGODB_URI=mongodb+srv://...

# Shared JWT secret — must equal JWT_ACCESS_SECRET from user-auth-service
JWT_ACCESS_SECRET=...
JWT_ISSUER=user-auth-service
JWT_AUDIENCE=dashboard-app

# External microservices
EMAIL_SERVICE_URL=http://email-service:4000
LEAD_SERVICE_URL=http://lead-microservice:4002
FILE_UPLOAD_SERVICE_URL=http://file-upload-service:4001
AUTH_SERVICE_URL=http://user-auth-service:4002

# Admin defaults
ADMIN_EMAIL=admin@yoursite.com

# Feature flags
ENABLE_SWAGGER=true
ENABLE_LOGGING=true
```

---

## Code Conventions

- ES modules (`import/export`), Node.js 18+.
- Express route files live in `routes/`, one file per resource.
- Validation rules in `validation/`, using `express-validator`.
- Models in `models/`, Mongoose schemas.
- Utility helpers in `utils/`.
- All email dispatch goes through `utils/email.js` helper functions — never call the email service URL directly from a route.
- Authentication on admin-only routes: use the `authenticate` middleware from `middleware/auth.js`. Access the caller via `req.user.id`, `req.user.email`, `req.user.role`.
- Non-blocking side-effects (emails, lead forwarding): always fire-and-forget with `.catch()` error logging, never `await` inline.
- All responses follow the shape `{ success: boolean, message: string, data?: any }`.
- Use `next(error)` to propagate errors to the global error handler in `middleware/errorHandler.js`.
- Pagination: use `getPaginationParams` / `getPaginationMeta` from `utils/pagination.js`.

---

## Folder Structure (keep this shape)

```
routes/          ← Express routers (contact, inquiry, newsletter, upload only)
models/          ← Mongoose models (Contact, Inquiry, Newsletter only)
middleware/      ← auth (JWT verify), errorHandler, validation, requestLogger
validation/      ← express-validator rule sets
utils/
  email.js       ← Email microservice client (only email dispatch helpers go here)
  errors.js      ← Custom error classes
  logger.js      ← Winston logger
  pagination.js  ← Pagination helpers
config/
  index.js       ← Centralised env config
  database.js    ← MongoDB connection
  jwt.js         ← JWT_ACCESS_SECRET + issuer/audience exports
```


---

## Microservice Architecture

This service depends on three external microservices. **Never duplicate their responsibilities here.**

### 1. User Auth Microservice
- Issues and owns JWT tokens.
- All incoming requests use JWTs signed by this service.
- **Auth middleware in this repo only verifies the JWT signature** using the shared `JWT_SECRET` — it does NOT call the auth service on every request.
- To authenticate admin actions from the frontend, the client must first log in via the user-auth microservice, then include the bearer token here.
- **Never add a local `/auth/login` or user-registration route.** Route those calls to the auth microservice.

### 2. Lead Microservice
- Owns CRM / lead pipeline logic.
- When an inquiry or contact form entry needs to progress through a sales funnel, forward it to the lead microservice.
- Call via HTTP from the relevant route handler using `axios` and the env var `LEAD_SERVICE_URL`.
- **Never replicate lead scoring, pipeline stages, or CRM models in this repo.**

### 3. Email Microservice
- All outgoing transactional emails **must** go through the email microservice.
- Use the helper functions in `utils/email.js`. Do **not** use `nodemailer` directly.
- Base URL is configured via `EMAIL_SERVICE_URL` env var (see `config/index.js`).
- Payload format: `{ to, templateId, data: { ...templateVariables } }`

---

## Email Template IDs

Use these exact `templateId` strings when calling the email microservice:

| Action | `templateId` | Key `data` fields |
|---|---|---|
| Contact form received (admin) | `CONTACT_NOTIFICATION` | `name, email, phone, company, subject, message, submittedAt, contactId` |
| Contact form auto-reply (user) | `CONTACT_CONFIRMATION` | `name, subject, companyName, contactId` |
| Inquiry received (admin) | `INQUIRY_NOTIFICATION` | `name, email, phone, company, projectType, budget, timeline, description, requirements, submittedAt, inquiryId, inquiryNumber` |
| Inquiry auto-reply (user) | `INQUIRY_CONFIRMATION` | `name, projectType, budget, timeline, companyName, inquiryId, inquiryNumber` |
| Newsletter double opt-in confirm | `NEWSLETTER_SUBSCRIBE_CONFIRMATION` | `name, email, confirmationUrl, companyName` |
| Newsletter welcome (post-confirm) | `NEWSLETTER_WELCOME` | `name, email, companyName, unsubscribeUrl` |
| Newsletter re-subscribe welcome | `NEWSLETTER_RESUBSCRIBE` | `name, email, companyName, unsubscribeUrl` |
| Newsletter farewell (unsubscribe) | `NEWSLETTER_FAREWELL` | `name, email, companyName` |
| Project proposal sent | `PROJECT_PROPOSAL_EMAIL` | `name, email, company, projectType, budget, timeline, inquiryId, inquiryNumber, proposalUrl, quotedAmount, quotedCurrency` |

---

## What NOT to Add

| Feature | Reason |
|---|---|
| Blog / CMS routes | Handled by a dedicated content service — do not add `/api/blogs` |
| Pricing / Plans routes | Handled separately — do not add `/api/plans` |
| Admin user management (create/list admins) | Owned by user-auth microservice |
| Local login or registration endpoints | Owned by user-auth microservice |
| Direct `nodemailer` usage | All email goes through the email microservice |
| Lead pipeline / CRM logic | Owned by lead microservice |

---

## Environment Variables

```env
# Service
PORT=3500
NODE_ENV=development
FRONTEND_URL=https://yoursite.com
CORS_ORIGINS=https://yoursite.com,https://admin.yoursite.com

# Database (only for contact, inquiry, newsletter, upload data)
MONGODB_URI=mongodb+srv://...

# Shared JWT secret — must match the user-auth microservice
JWT_SECRET=...

# External microservices
EMAIL_SERVICE_URL=http://email-service:4000
LEAD_SERVICE_URL=http://lead-service:4100

# Admin defaults
ADMIN_EMAIL=admin@yoursite.com

# Feature flags
ENABLE_SWAGGER=true
ENABLE_LOGGING=true
```

---

## Code Conventions

- ES modules (`import/export`), Node.js 18+.
- Express route files live in `routes/`, one file per resource.
- Validation rules in `validation/`, using `express-validator`.
- Models in `models/`, Mongoose schemas.
- Utility helpers in `utils/`.
- All email dispatch goes through `utils/email.js` helper functions — never call the email service URL directly from a route.
- Authentication on admin-only routes: use the `authenticate` middleware from `middleware/auth.js`.
- Non-blocking side-effects (emails, lead forwarding): always fire-and-forget with `.catch()` error logging, never `await` inline.
- All responses follow the shape `{ success: boolean, message: string, data?: any }`.
- Use `next(error)` to propagate errors to the global error handler in `middleware/errorHandler.js`.
- Pagination: use `getPaginationParams` / `getPaginationMeta` from `utils/pagination.js`.

---

## Folder Structure (keep this shape)

```
routes/          ← Express routers (contact, inquiry, newsletter, upload only)
models/          ← Mongoose models (Contact, Inquiry, Newsletter only)
middleware/      ← auth (JWT verify), errorHandler, validation, requestLogger
validation/      ← express-validator rule sets
utils/
  email.js       ← Email microservice client (only email dispatch helpers go here)
  errors.js      ← Custom error classes
  logger.js      ← Winston logger
  pagination.js  ← Pagination helpers
config/
  index.js       ← Centralised env config
  database.js    ← MongoDB connection
  jwt.js         ← JWT secret export
```
