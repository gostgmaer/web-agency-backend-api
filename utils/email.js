import { config } from "../config/index.js";
import logger from "./logger.js";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();
const EMAIL_SERVICE_URL = `${config.email.serviceUrl}/v1/email/send`;
const EMAIL_API_KEY = process.env.EMAIL_SERVICE_API_KEY || '';

/**
 * Extracts the pathname + search from a full URL, or returns the string as-is
 * when it is already a relative path (starts with '/').
 */
const extractPath = (urlOrPath) => {
	if (!urlOrPath) return '/dashboard';
	if (urlOrPath.startsWith('/')) return urlOrPath;
	try {
		const { pathname, search } = new URL(urlOrPath);
		return pathname + search;
	} catch {
		return urlOrPath;
	}
};

const APP_NAME = process.env.APP_NAME || 'EasyDev';

export const sendEmail = async (options) => {
  try {
		// Normalise: notification service uses `template`, not `templateId`
		const { templateId, path, idempotencyKey, ...rest } = options;
		const template = options.template ?? templateId;
		const payload = { ...rest, template };

		console.log("Email send:", { to: payload.to, template: payload.template });

		const tenantId = config.tenantId;
		if (!tenantId) throw new Error('TENANT_ID env var is not set — cannot send email without a tenant ID');
		// Auto-generate idempotency key matching the pattern used across all services:
		// {template_lowercase}-{tenantId}-{recipient}
		const resolvedIdempotencyKey =
			idempotencyKey || `${template.toLowerCase()}-${tenantId}-${payload.to}`;

		const headers = {
			"Content-Type": "application/json",
			...(EMAIL_API_KEY ? { "x-api-key": EMAIL_API_KEY } : {}),
			"x-tenant-id": tenantId,
			"x-app": APP_NAME,
			"x-app-name": APP_NAME,
			"x-app-url": config.app.frontendUrl || "http://localhost:3000",
			"x-path": path || "/dashboard",
			"x-idempotency-key": resolvedIdempotencyKey,
		};

		const response = await axios.post(EMAIL_SERVICE_URL, payload, {
			headers,
			timeout: 8000,
		});

		logger.info("Email sent successfully", { templateId: options.templateId, to: options.to });

		return response.data;
	} catch (error) {
		logger.error("Email sending failed:", {
			message: error.message,
			status: error.response?.status,
			data: error.response?.data,
		});

		throw error;
	}
};

/**
 * Sends the double opt-in confirmation email when a user first subscribes.
 * Template: NEWSLETTER_SUBSCRIBE_CONFIRMATION
 */
export const sendNewsletterSubscriptionConfirmation = async (subscriber) => {
	try {
		const confirmationUrl = `${config.app.frontendUrl || "http://localhost:3000"}/newsletter/confirm?token=${subscriber.confirmationToken}`;
		await sendEmail({
			to: subscriber.email,
			templateId: "NEWSLETTER_SUBSCRIBE_CONFIRMATION",
			path: extractPath(confirmationUrl),
			data: {
				name: subscriber.name || subscriber.email,
				email: subscriber.email,
				confirmationUrl,
				companyName: "Web Agency",
			},
		});
	} catch (error) {
		logger.error("Failed to send newsletter subscription confirmation email:", error);
		throw error;
	}
};

/**
 * Sends a welcome email after the subscriber confirms their subscription.
 * Template: NEWSLETTER_WELCOME
 */
export const sendNewsletterWelcomeConfirmed = async (subscriber) => {
	try {
		const unsubscribeUrl = `${config.app.frontendUrl || "http://localhost:3000"}/newsletter/unsubscribe?email=${encodeURIComponent(subscriber.email)}`;
		await sendEmail({
			to: subscriber.email,
			templateId: "NEWSLETTER_WELCOME",
			path: extractPath(unsubscribeUrl),
			data: {
				name: subscriber.name || subscriber.email,
				email: subscriber.email,
				companyName: "Web Agency",
				unsubscribeUrl,
			},
		});
	} catch (error) {
		logger.error("Failed to send newsletter welcome email:", error);
		throw error;
	}
};

/**
 * Sends a welcome-back email when a user re-subscribes.
 * Template: NEWSLETTER_RESUBSCRIBE
 */
export const sendNewsletterResubscribeWelcome = async (subscriber) => {
	try {
		const unsubscribeUrl = `${config.app.frontendUrl || "http://localhost:3000"}/newsletter/unsubscribe?email=${encodeURIComponent(subscriber.email)}`;
		await sendEmail({
			to: subscriber.email,
			templateId: "NEWSLETTER_RESUBSCRIBE",
			path: extractPath(unsubscribeUrl),
			data: {
				name: subscriber.name || subscriber.email,
				email: subscriber.email,
				companyName: "Web Agency",
				unsubscribeUrl,
			},
		});
	} catch (error) {
		logger.error("Failed to send newsletter re-subscribe welcome email:", error);
		throw error;
	}
};

/**
 * Sends a farewell email when a user unsubscribes.
 * Template: NEWSLETTER_FAREWELL
 */
export const sendNewsletterFarewell = async (subscriber) => {
	try {
		await sendEmail({
			to: subscriber.email,
			templateId: "NEWSLETTER_FAREWELL",
			path: '/newsletter/unsubscribe',
			data: {
				name: subscriber.name || subscriber.email,
				email: subscriber.email,
				companyName: "Web Agency",
			},
		});
	} catch (error) {
		logger.error("Failed to send newsletter farewell email:", error);
		throw error;
	}
};

/**
 * Sends a welcome email after a user purchases and their AI Communication account is provisioned.
 * Template: AI_COMMUNICATION_WELCOME
 *
 * @param {{ name: string, email: string, loginUrl: string, temporaryPassword: string, planName: string }} params
 */
export const sendAiCommunicationWelcome = async ({ name, email, loginUrl, temporaryPassword, planName }) => {
	try {
		await sendEmail({
			to: email,
			templateId: 'USER_CREATED',
			path: extractPath(loginUrl),
			data: {
				name: name || email,
				email,
				loginUrl,
				temporaryPassword,
				planName: planName || 'Pro',
				companyName: 'EasyDev',
				appName: 'EasyDev Communication AI',
				supportEmail: config.admin.email || 'support@easydev.in',
			},
		});
		logger.info('AI Communication welcome email sent', { email });
	} catch (error) {
		logger.error('Failed to send AI Communication welcome email', { email, error: error.message });
		// non-fatal — do not re-throw
	}
};

/**
 * Notifies a new customer that their account has been created with login credentials.
 * Template: ADMIN_CREATED_USER
 *
 * @param {{ username: string, email: string, temporaryPassword: string, loginUrl: string }} params
 */
export const sendAdminCreatedUser = async ({ username, email, temporaryPassword, loginUrl }) => {
	try {
		await sendEmail({
			to: email,
			templateId: 'ADMIN_CREATED_USER',
			path: extractPath(loginUrl),
			data: {
				username: username || email,
				email,
				temporaryPassword,
				loginUrl,
				companyName: 'EasyDev',
				supportEmail: config.admin.email || 'support@easydev.in',
			},
		});
		logger.info('Admin created user email sent', { email });
	} catch (error) {
		logger.error('Failed to send admin created user email', { email, error: error.message });
		// non-fatal — do not re-throw
	}
};

/**
 * Sends a product access email with SSO link after a purchase is provisioned.
 * Template: PRODUCT_ACCESS_GRANTED
 *
 * @param {{
 *   username: string,
 *   email: string,
 *   productName: string,
 *   productDescription: string,
 *   productUrl: string,
 *   planType: string,
 *   accessStartDate: Date,
 *   accessEndDate: Date,
 *   features: string[],
 * }} params
 */
export const sendProductAccessGranted = async ({
	username,
	email,
	productName,
	productDescription,
	productUrl,
	planType,
	accessStartDate,
	accessEndDate,
	features,
}) => {
	try {
		await sendEmail({
			to: email,
			templateId: 'PRODUCT_ACCESS_GRANTED',
			path: extractPath(productUrl),
			data: {
				username: username || email,
				email,
				productName,
				productDescription: productDescription || '',
				productUrl,
				planType: planType || 'yearly',
				accessStartDate: accessStartDate instanceof Date ? accessStartDate.toISOString() : accessStartDate,
				// accessEndDate: accessEndDate instanceof Date ? accessEndDate.toISOString() : accessEndDate,
				features: features || [],
				companyName: 'EasyDev',
				supportEmail: config.admin.email || 'support@easydev.in',
			},
		});
		logger.info('Product access granted email sent', { email, productName });
	} catch (error) {
		logger.error('Failed to send product access granted email', { email, productName, error: error.message });
		// non-fatal — do not re-throw
	}
};
