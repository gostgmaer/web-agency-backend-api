---
applyTo: "routes/newsletter.js,models/Newsletter.js,validation/newsletterValidation.js"
---

# Newsletter API Guidelines

## Overview
The newsletter feature is a self-contained double opt-in subscription system stored in MongoDB (`Newsletter` model). **All email sending goes through the email microservice via `utils/email.js`.**

## Subscription lifecycle & required emails

| Event | Email helper to call | Template ID | When |
|---|---|---|---|
| New subscription | `sendNewsletterSubscriptionConfirmation(subscriber)` | `NEWSLETTER_SUBSCRIBE_CONFIRMATION` | At subscribe time (before confirmation) |
| Re-subscribe (was inactive) | `sendNewsletterResubscribeWelcome(subscriber)` | `NEWSLETTER_RESUBSCRIBE` | At subscribe time (no re-confirmation needed) |
| Token confirmed | `sendNewsletterWelcomeConfirmed(subscriber)` | `NEWSLETTER_WELCOME` | After `GET /api/newsletter/confirm/:token` succeeds |
| Unsubscribe | `sendNewsletterFarewell(subscriber)` | `NEWSLETTER_FAREWELL` | After `POST /api/newsletter/unsubscribe` |

## Confirmation URL pattern

The link in the opt-in email must point to the **frontend**, not this API's confirm endpoint:

```js
const confirmationUrl = `${config.app.frontendUrl}/newsletter/confirm?token=${subscriber.confirmationToken}`;
```

The frontend then calls: `GET /api/newsletter/confirm/:token`

## Unsubscribe URL pattern

```js
const unsubscribeUrl = `${config.app.frontendUrl}/newsletter/unsubscribe?email=${encodeURIComponent(subscriber.email)}`;
```

## Rules

### Double opt-in is mandatory
- New subscribers start with `isConfirmed: false`.
- The **welcome email is only sent after the `/confirm/:token` endpoint is hit**, not at subscribe time.
- At subscribe time, send only the `NEWSLETTER_SUBSCRIBE_CONFIRMATION` email (the confirmation link).

### Emails are always fire-and-forget

```js
// ✅ Right
sendNewsletterSubscriptionConfirmation(subscriber).catch(err =>
  logger.error('Failed to send confirmation email:', { error: err.message, email: subscriber.email })
);

// ❌ Wrong — never await email calls in route handlers
await sendNewsletterSubscriptionConfirmation(subscriber);
```

### Admin routes use JWT from user-auth-service

All admin newsletter routes use the `authenticate` middleware which validates the JWT issued by the user-auth-service:
- `GET /api/newsletter/subscribers` — list subscribers (paginated)
- `PUT /api/newsletter/subscriber/:id/tags` — update subscriber tags
- `DELETE /api/newsletter/subscriber/:id` — hard delete subscriber

Use `req.user.email` and `req.user.id` (not `req.admin`).

## What NOT to add to the newsletter module

- Do NOT add a newsletter broadcast/send-campaign endpoint — that belongs in the email microservice.
- Do NOT manage email templates here — template content lives in the email microservice.
- Do NOT add blog subscription logic — handle in a content service.
- Do NOT store or validate plaintext email credentials.
