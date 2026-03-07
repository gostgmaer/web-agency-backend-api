---
applyTo: "routes/inquiry.js,routes/contact.js"
---

# Lead Microservice Integration

Source: `../lead-microservice`

Owns all CRM / sales pipeline lifecycle. When a contact form or project inquiry enters the funnel, forward it to the lead microservice via `POST /api/leads/submit`.

## Base URL

Configured via `LEAD_SERVICE_URL` env var:
```js
import { config } from '../config/index.js';
const LEAD_SERVICE_URL = config.lead.serviceUrl; // http://lead-microservice:4002
```

## Forwarding a contact/inquiry as a lead (fire-and-forget)

The lead microservice's **public** submit endpoint requires the `x-tenant-id` header.

```js
import axios from 'axios';

// Fire-and-forget — never await inline in a route handler
axios.post(`${config.lead.serviceUrl}/api/leads/submit`, {
  firstName:              contact.name.split(' ')[0],
  lastName:               contact.name.split(' ').slice(1).join(' ') || '-',
  email:                  contact.email,
  phone:                  contact.phone,
  subject:                contact.subject,
  message:                contact.message,
  gdprConsent:            true,
  source:                 'website',
  category:               'General Inquiry',
  preferredContactMethod: 'email',
}, {
  headers: { 'x-tenant-id': process.env.TENANT_ID || 'default' },
  timeout: 5000,
}).catch(err =>
  logger.error('Failed to forward contact to lead service:', { error: err.message, contactId: contact._id })
);
```

## Lead submit payload reference

```json
{
  "firstName":              "string (required)",
  "lastName":               "string (required)",
  "email":                  "valid email (required)",
  "subject":                "string (required, max 200)",
  "message":                "string (required, max 5000)",
  "phone":                  "string (optional)",
  "gdprConsent":            true,
  "budget":                 "under-5k | 5k-10k | 10k-25k | 25k-50k | 50k-100k | over-100k | not-sure",
  "timeline":               "asap | 1-month | 2-3months | 3-6months | 6months+ | flexible",
  "projectType":            "website | webapp | mobile | ecommerce | redesign | maintenance | consulting | other",
  "category":               "General Inquiry | Technical Support | Sales | Partnership | Feedback | Career | Other",
  "preferredContactMethod": "email | phone | whatsapp | any",
  "website":                "URL (optional)",
  "customFields":           {}
}
```

## Required header

The lead microservice enforces `x-tenant-id` on all public submissions:
```js
headers: { 'x-tenant-id': process.env.TENANT_ID || 'default' }
```

## What NOT to add in this service

- Do NOT create pipeline stages, lead scoring, or deal models here.
- Do NOT add a `/api/leads` route in this service.
- Do NOT replicate lead email templates — the lead microservice sends its own lead notification emails.
- All CRM progression, follow-ups, proposal/contract logic, and analytics belong in the lead microservice.
