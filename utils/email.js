import logger from './logger.js';
import dotenv from "dotenv";

const EMAIL_SERVICE_URL =
  `${process.env.EMAIL_SERVICE_URL || 'http://localhost:3100'}/send-email`;



export const sendEmail = async (options) => {
  try {
    const response = await fetch(EMAIL_SERVICE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(options)
    });

    if (!response.ok) {
      throw new Error(`Email service responded with status: ${response.status}`);
    }

    const result = await response.json();
    logger.info('Email sent successfully', { templateId: options.templateId, to: options.to });
    return result;
  } catch (error) {
    logger.error('Email sending failed:', error);
    throw error;
  }
};

export const sendContactNotification = async (contact) => {
  try {
    await sendEmail({
      to: process.env.ADMIN_EMAIL || 'admin@easydev.in',
      templateId: 'CONTACT_NOTIFICATION',
      data: {
        name: contact.name,
        email: contact.email,
        phone: contact.phone || 'Not provided',
        company: contact.company || 'Not provided',
        subject: contact.subject,
        message: contact.message,
        submittedAt: new Date(contact.createdAt).toLocaleString(),
        contactId: contact._id.toString()
      }
    });
  } catch (error) {
    logger.error('Failed to send contact notification email:', error);
    throw error;
  }
};

export const sendInquiryNotification = async (inquiry) => {
  try {
    await sendEmail({
      to: process.env.ADMIN_EMAIL || 'admin@easydev.in',
      templateId: 'INQUIRY_NOTIFICATION',
      data: {
        name: inquiry.name,
        email: inquiry.email,
        phone: inquiry.phone || 'Not provided',
        company: inquiry.company || 'Not provided',
        projectType: inquiry.projectType,
        budget: inquiry.budget,
        timeline: inquiry.timeline,
        description: inquiry.description,
        requirements: inquiry.requirements || [],
        submittedAt: new Date(inquiry.createdAt).toLocaleString(),
        inquiryId: inquiry._id.toString()
      }
    });
  } catch (error) {
    logger.error('Failed to send inquiry notification email:', error);
    throw error;
  }
};

export const sendWelcomeEmail = async (email) => {
  try {
    await sendEmail({
      to: email,
      templateId: 'NEWSLETTER_WELCOME',
      data: {
        email: email,
        companyName: 'Web Agency',
        unsubscribeUrl: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/unsubscribe`
      }
    });
  } catch (error) {
    logger.error('Failed to send welcome email:', error);
    throw error;
  }
};

export const sendContactConfirmation = async (contact) => {
  try {
    await sendEmail({
      to: contact.email,
      templateId: 'CONTACT_CONFIRMATION',
      data: {
        name: contact.name,
        subject: contact.subject,
        companyName: 'Web Agency',
        contactId: contact._id.toString()
      }
    });
  } catch (error) {
    logger.error('Failed to send contact confirmation email:', error);
    throw error;
  }
};

export const sendInquiryConfirmation = async (inquiry) => {
  try {
    await sendEmail({
      to: inquiry.email,
      templateId: 'INQUIRY_CONFIRMATION',
      data: {
        name: inquiry.name,
        projectType: inquiry.projectType,
        budget: inquiry.budget,
        timeline: inquiry.timeline,
        companyName: 'Web Agency',
        inquiryId: inquiry._id.toString()
      }
    });
  } catch (error) {
    logger.error('Failed to send inquiry confirmation email:', error);
    throw error;
  }
};

// Alias for newsletter routes
export const sendNewsletterWelcome = sendWelcomeEmail;