# Web Agency Backend API Documentation

## Base URL
```
http://localhost:3000/api
```

## Authentication
All admin endpoints require a Bearer token in the Authorization header:
```
Authorization: Bearer <your_jwt_token>
```

---

## Auth Endpoints

### POST `/auth/login`
Login with admin credentials.

**Request Body:**
```json
{
  "email": "admin@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "admin": { "id": "...", "email": "...", "name": "...", "role": "admin" },
    "token": "jwt_token_here",
    "refreshToken": "refresh_token_here",
    "expiresIn": "7d"
  }
}
```

> **Note:** Account locks after 5 failed attempts for 2 hours.

---

### POST `/auth/refresh`
Refresh the access token.

**Request Body:**
```json
{
  "refreshToken": "your_refresh_token"
}
```

---

### GET `/auth/profile` 🔒
Get current admin profile.

---

### PUT `/auth/profile` 🔒
Update current admin profile.

**Request Body:**
```json
{
  "name": "New Name",
  "avatar": "https://example.com/avatar.jpg"
}
```

---

### POST `/auth/change-password` 🔒
Change password.

**Request Body:**
```json
{
  "currentPassword": "oldpass123",
  "newPassword": "newpass123"
}
```

---

### POST `/auth/logout` 🔒
Logout current admin.

---

### GET `/auth/verify` 🔒
Verify if token is valid.

---

## Blog Endpoints

### GET `/blogs`
Get published blogs with pagination and filtering.

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| page | number | Page number (default: 1) |
| limit | number | Items per page (default: 10, max: 100) |
| category | string | Filter by category |
| tag | string | Filter by tag |
| search | string | Text search in title, excerpt, content |
| sort | string | `views`, `likes`, `oldest` (default: newest) |

---

### GET `/blogs/featured`
Get popular blogs by views/likes.

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| limit | number | Number of blogs (default: 5) |

---

### GET `/blogs/categories`
Get all categories with post counts.

**Response:**
```json
{
  "success": true,
  "data": {
    "categories": [
      { "_id": "technology", "count": 15 },
      { "_id": "design", "count": 8 }
    ]
  }
}
```

---

### GET `/blogs/tags`
Get all tags with counts (top 50).

---

### GET `/blogs/:slug`
Get a single blog by slug. Increments view count. Returns related blogs.

---

### POST `/blogs/:id/like`
Like a blog post.

---

### GET `/blogs/admin` 🔒
Get all blogs including drafts.

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| status | string | `published` or `draft` |
| search | string | Search in title/excerpt |

---

### POST `/blogs` 🔒
Create a new blog.

**Request Body:**
```json
{
  "title": "Blog Title",
  "slug": "blog-title",
  "content": "<p>Full content...</p>",
  "excerpt": "Brief summary",
  "featuredImage": "https://example.com/image.jpg",
  "categories": ["technology", "web-dev"],
  "tags": ["nodejs", "express"],
  "isPublished": false,
  "metaTitle": "SEO Title",
  "metaDescription": "SEO Description"
}
```

---

### PUT `/blogs/:id` 🔒
Update a blog.

---

### PATCH `/blogs/:id/publish` 🔒
Publish or unpublish a blog.

**Request Body:**
```json
{ "isPublished": true }
```

---

### DELETE `/blogs/:id` 🔒
Soft delete a blog.

---

### PATCH `/blogs/:id/restore` 🔒
Restore a soft-deleted blog.

---

## Contact Endpoints

### POST `/contact`
Submit a contact form (public).

**Request Body:**
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "phone": "+1234567890",
  "company": "Acme Inc",
  "subject": "Project Inquiry",
  "message": "I would like to discuss..."
}
```

> **Note:** Priority is auto-detected based on keywords (urgent, asap, important).

---

### GET `/contact` 🔒
Get all contacts.

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| status | string | `new`, `read`, `replied`, `closed`, `spam` |
| priority | string | `low`, `medium`, `high`, `urgent` |
| search | string | Text search |

---

### GET `/contact/stats` 🔒
Get contact statistics.

**Response:**
```json
{
  "success": true,
  "data": {
    "total": 150,
    "today": 5,
    "byStatus": { "new": 10, "read": 50, "replied": 80, "closed": 10 }
  }
}
```

---

### GET `/contact/:id` 🔒
Get contact by ID. Automatically marks as read.

---

### PATCH `/contact/:id/status` 🔒
Update contact status.

**Request Body:**
```json
{
  "status": "read",
  "adminNotes": "Will follow up next week"
}
```

---

### POST `/contact/:id/reply` 🔒
Reply to a contact.

**Request Body:**
```json
{ "replyMessage": "Thank you for contacting us..." }
```

---

### PATCH `/contact/:id/spam` 🔒
Mark contact as spam.

---

### DELETE `/contact/:id` 🔒
Soft delete contact.

---

## Inquiry Endpoints

### POST `/inquiry`
Submit a project inquiry (public).

**Request Body:**
```json
{
  "name": "Jane Smith",
  "email": "jane@company.com",
  "phone": "+1234567890",
  "company": "Tech Corp",
  "website": "https://techcorp.com",
  "projectType": "webapp",
  "budget": "25k-50k",
  "timeline": "2-3months",
  "description": "We need a custom web application...",
  "requirements": ["user-auth", "dashboard", "api-integration"]
}
```

**Enum Values:**
- `projectType`: website, webapp, mobile, ecommerce, redesign, maintenance, consulting, other
- `budget`: under-5k, 5k-10k, 10k-25k, 25k-50k, 50k-100k, over-100k, not-sure
- `timeline`: asap, 1-month, 2-3months, 3-6months, 6months+, flexible

---

### GET `/inquiry` 🔒
Get all inquiries.

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| status | string | See status enum below |
| priority | string | `low`, `medium`, `high`, `urgent` |
| projectType | string | Filter by project type |
| assignedTo | string | Admin ID |
| search | string | Search name/email/company |

**Status values:** new, reviewing, contacted, quoted, negotiating, accepted, rejected, completed, cancelled

---

### GET `/inquiry/stats` 🔒
Get inquiry statistics.

---

### GET `/inquiry/follow-up` 🔒
Get inquiries due for follow-up.

---

### GET `/inquiry/:id` 🔒
Get full inquiry with notes and status history.

---

### PATCH `/inquiry/:id/status` 🔒
Update inquiry status.

**Request Body:**
```json
{
  "status": "reviewing",
  "note": "Initial review started"
}
```

---

### PATCH `/inquiry/:id/assign` 🔒
Assign inquiry to admin.

**Request Body:**
```json
{ "assignTo": "admin_id_here" }
```

---

### PATCH `/inquiry/:id/quote` 🔒
Set quote for inquiry.

**Request Body:**
```json
{
  "amount": 35000,
  "currency": "USD"
}
```

---

### POST `/inquiry/:id/note` 🔒
Add note to inquiry.

**Request Body:**
```json
{
  "content": "Called client, discussed requirements.",
  "isInternal": true
}
```

---

### PATCH `/inquiry/:id/follow-up` 🔒
Set follow-up date.

**Request Body:**
```json
{ "date": "2026-02-15T10:00:00Z" }
```

---

### DELETE `/inquiry/:id` 🔒
Soft delete inquiry.

---

## Newsletter Endpoints

### POST `/newsletter/subscribe`
Subscribe to newsletter (public).

**Request Body:**
```json
{
  "email": "subscriber@example.com",
  "name": "John",
  "preferences": {
    "frequency": "weekly",
    "categories": ["technology", "design"]
  }
}
```

> **Note:** Requires email confirmation (double opt-in).

---

### GET `/newsletter/confirm/:token`
Confirm subscription via email token.

---

### POST `/newsletter/unsubscribe`
Unsubscribe from newsletter.

**Request Body:**
```json
{
  "email": "subscriber@example.com",
  "reason": "too-many",
  "feedback": "I receive too many emails"
}
```

**Reason values:** too-many, not-relevant, never-subscribed, other

---

### GET `/newsletter/subscribers` 🔒
Get all subscribers.

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| isActive | boolean | Filter active/inactive |
| isConfirmed | boolean | Filter confirmed/pending |
| tag | string | Filter by tag |
| search | string | Search email/name |

---

### GET `/newsletter/stats` 🔒
Get newsletter statistics with growth metrics.

**Response:**
```json
{
  "success": true,
  "data": {
    "total": 5000,
    "active": 4500,
    "confirmed": 4200,
    "totalEmailsSent": 25000,
    "totalOpened": 12500,
    "totalClicked": 3000,
    "recentGrowth": {
      "period": "30 days",
      "newSubscribers": 150,
      "unsubscribes": 20,
      "netGrowth": 130
    }
  }
}
```

---

### GET `/newsletter/subscriber/:id` 🔒
Get subscriber details.

---

### PATCH `/newsletter/subscriber/:id/tags` 🔒
Update subscriber tags.

**Request Body:**
```json
{ "tags": ["vip", "early-adopter"] }
```

---

### POST `/newsletter/track/open`
Track email open (for tracking pixel).

---

### POST `/newsletter/track/click`
Track email link click.

---

### DELETE `/newsletter/subscriber/:id` 🔒
Delete subscriber permanently.

---

## Plans Endpoints

### GET `/plans`
Get active plans (public).

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| category | string | Filter by category |
| billingCycle | string | Filter by billing cycle |
| targetAudience | string | starter, small-business, enterprise, agency |

**Category values:** website, webapp, ecommerce, maintenance, hosting, consulting, bundle
**Billing cycle values:** monthly, quarterly, yearly, one-time, custom

---

### GET `/plans/featured`
Get featured/popular plans.

---

### GET `/plans/compare?ids=id1,id2,id3`
Compare 2-4 plans with feature matrix.

---

### GET `/plans/categories`
Get plan categories with counts.

---

### GET `/plans/:slug`
Get plan by slug.

---

### GET `/plans/admin` 🔒
Get all plans including inactive/archived.

---

### POST `/plans` 🔒
Create a new plan.

**Request Body:**
```json
{
  "name": "Business Website",
  "slug": "business-website",
  "description": "Complete business website solution.",
  "price": 2499,
  "originalPrice": 2999,
  "currency": "USD",
  "billingCycle": "one-time",
  "category": "website",
  "features": [
    { "name": "Pages", "included": true, "value": "Up to 10" },
    { "name": "SEO", "included": true, "highlight": true },
    { "name": "E-commerce", "included": false }
  ],
  "limits": {
    "pages": 10,
    "storage": "5GB",
    "revisions": 3,
    "supportLevel": "priority"
  },
  "isPopular": true,
  "badge": "Best Value",
  "order": 2
}
```

---

### PUT `/plans/:id` 🔒
Update a plan.

---

### PATCH `/plans/:id/activate` 🔒
Activate/deactivate plan.

**Request Body:**
```json
{ "isActive": true }
```

---

### PATCH `/plans/:id/archive` 🔒
Archive a plan.

---

### PATCH `/plans/:id/restore` 🔒
Restore archived plan.

---

### POST `/plans/:id/duplicate` 🔒
Duplicate a plan.

**Request Body:**
```json
{ "newSlug": "business-website-v2" }
```

---

### PATCH `/plans/reorder` 🔒
Reorder plans.

**Request Body:**
```json
{
  "orders": [
    { "id": "plan1_id", "order": 1 },
    { "id": "plan2_id", "order": 2 }
  ]
}
```

---

### DELETE `/plans/:id` 🔒
Delete plan permanently.

---

## Health Endpoints

### GET `/health`
Server health check.

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| detailed | boolean | Include memory metrics |

---

### GET `/ready`
Readiness check (database connection).

---

## Error Responses

All errors follow this format:
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable error message",
    "errorId": "ERR-M5X2K-7QR4T"
  }
}
```

**Error Codes:**
| Code | HTTP Status | Description |
|------|-------------|-------------|
| VALIDATION_ERROR | 400 | Invalid request data |
| AUTHENTICATION_ERROR | 401 | Invalid or missing token |
| AUTHORIZATION_ERROR | 403 | Insufficient permissions |
| NOT_FOUND | 404 | Resource not found |
| CONFLICT | 409 | Duplicate resource |
| RATE_LIMIT_ERROR | 429 | Too many requests |
| INTERNAL_ERROR | 500 | Server error |

---

## Pagination

All list endpoints support pagination:

**Request:**
```
GET /api/blogs?page=2&limit=20
```

**Response:**
```json
{
  "success": true,
  "data": {
    "blogs": [...],
    "pagination": {
      "currentPage": 2,
      "totalPages": 10,
      "totalItems": 200,
      "itemsPerPage": 20,
      "hasNextPage": true,
      "hasPrevPage": true,
      "nextPage": 3,
      "prevPage": 1
    }
  }
}
```

---

## Rate Limiting

- **General:** 200 requests per minute per IP
- **Auth endpoints:** 20 requests per 15 minutes per IP
- **Health check:** Excluded from rate limiting

---

## Legend
- 🔒 = Requires authentication (Bearer token)
