---
applyTo: "utils/email.js,routes/**,services/**"
---

# Email Microservice Integration

All outgoing emails in this service are sent through the external email microservice (URL via `EMAIL_SERVICE_URL`).

## Never do this

```js
// ❌ Direct nodemailer usage
import nodemailer from 'nodemailer';
const transporter = nodemailer.createTransport(...);

// ❌ Calling the email service URL directly from a route
await axios.post(process.env.EMAIL_SERVICE_URL + '/send-email', payload);
```

## Always do this

```js
// ✅ Use the helper from utils/email.js
import { sendContactNotification } from '../utils/email.js';
sendContactNotification(contact).catch(err => logger.error('...', err));
```

## Adding a new email helper in `utils/email.js`

Every helper must call the shared `sendEmail()` function:

```js
export const sendMyNewEmail = async (data) => {
  try {
    await sendEmail({
      to: data.recipientEmail,
      templateId: 'MY_TEMPLATE_ID',  // exact ID as defined by email microservice
      data: {
        name: data.name,
        // ...template variables matching the template definition
      },
    });
  } catch (error) {
    logger.error('Failed to send my new email:', error);
    throw error;
  }
};
```

## Template IDs reference

| Email purpose | `templateId` | Required `data` fields |
|---|---|---|
| Contact received (admin) | `CONTACT_NOTIFICATION` | `name, email, phone, company, subject, message, submittedAt, contactId` |
| Contact auto-reply (user) | `CONTACT_CONFIRMATION` | `name, subject, companyName, contactId` |
| Inquiry received (admin) | `INQUIRY_NOTIFICATION` | `name, email, phone, company, projectType, budget, timeline, description, requirements, submittedAt, inquiryId, inquiryNumber` |
| Inquiry auto-reply (user) | `INQUIRY_CONFIRMATION` | `name, projectType, budget, timeline, companyName, inquiryId, inquiryNumber` |
| Newsletter double opt-in | `NEWSLETTER_SUBSCRIBE_CONFIRMATION` | `name, email, confirmationUrl, companyName` |
| Newsletter welcome (post confirm) | `NEWSLETTER_WELCOME` | `name, email, companyName, unsubscribeUrl` |
| Newsletter re-subscribe | `NEWSLETTER_RESUBSCRIBE` | `name, email, companyName, unsubscribeUrl` |
| Newsletter farewell | `NEWSLETTER_FAREWELL` | `name, email, companyName` |
| Proposal sent | `PROJECT_PROPOSAL_EMAIL` | `name, email, company, projectType, budget, timeline, inquiryId, inquiryNumber, proposalUrl, quotedAmount, quotedCurrency` |

## Fire-and-forget pattern (required for all routes)

Email calls are non-blocking side-effects. **Never `await` them inline in a route handler.**

```js
// ✅ Correct — non-blocking, error isolated
sendNewsletterSubscriptionConfirmation(subscriber).catch(err =>
  logger.error('Failed to send confirmation email:', { error: err.message, email: subscriber.email })
);

// ✅ Multiple emails together
Promise.all([
  sendContactNotification(contact),
  sendContactConfirmation(contact),
]).catch(err =>
  logger.error('Failed to send contact emails:', { error: err.message, contactId: contact._id })
);

// ❌ Wrong — blocks route, propagates email failure to the HTTP caller
await sendWelcomeEmail(subscriber);
```
