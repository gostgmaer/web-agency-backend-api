---
applyTo: "routes/**,middleware/auth.js"
---

# Authentication & Authorization

## How auth works in this service

JWTs are issued exclusively by the shared IAM service in `../multi-tannet-auth-services`. This service only **verifies** them.

The `authenticate` middleware in `middleware/auth.js`:
1. Extracts the `Bearer` token from the `Authorization` header.
2. Verifies the signature against `JWT_ACCESS_SECRET` (must equal `JWT_SECRET` in the IAM service).
3. Validates `iss === 'user-auth-service'` and `aud === 'dashboard-app'` claims.
4. Attaches a normalized `req.user` object from the decoded payload.
5. **No database call.** No call to the auth service. Stateless verification only.

## req.user shape (after authenticate)

```js
req.user = {
  id: decoded.sub,        // User id from the IAM access token
  email: decoded.email,
  role: decoded.role,     // e.g. 'admin', 'super_admin', 'user'
  tenantId: decoded.tenantId,
  sessionId: decoded.sessionId,
};
```

## Protecting a route

```js
import { authenticate } from '../middleware/auth.js';

router.get('/admin-only', authenticate, async (req, res, next) => {
  // req.user.id, req.user.email, req.user.role, req.user.tenantId are all available
});
```

## Role-based access (optional)

```js
import { authenticate, authorize } from '../middleware/auth.js';

router.delete('/resource/:id',
  authenticate,
  authorize('admin', 'super_admin'),
  handler
);
```

## Never do this

```js
// ❌ Do NOT add a local login or registration endpoint
router.post('/login', ...);
router.post('/register', ...);

// ❌ Do NOT query a local Admin/User model to validate the token
const admin = await Admin.findById(decoded.id);

// ❌ Do NOT create or sign JWT tokens in this service
const token = jwt.sign({ id: user._id }, process.env.JWT_ACCESS_SECRET);

// ❌ Do NOT use the old JWT_SECRET env var — the correct var is JWT_ACCESS_SECRET
jwt.verify(token, process.env.JWT_SECRET);
```

## Where admin login happens

Direct all login requests to the shared IAM service behind `AUTH_SERVICE_URL`.

Recommended local target in this workspace:

```text
AUTH_SERVICE_URL=http://localhost:4002
```

| Action | Endpoint |
|---|---|
| Login | `POST /api/auth/login` |
| Account check | `POST /api/auth/check` |
| Refresh token | `POST /api/auth/refresh` |
| Logout | `POST /api/auth/logout` |
| Get own profile | `GET /api/auth/me` |

The web-agency-backend **never issues or revokes tokens**.
