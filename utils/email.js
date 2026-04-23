import { config } from "../config/index.js";
import logger from "./logger.js";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();
const EMAIL_SERVICE_URL = `${config.email.serviceUrl}/send-email`;

export const sendEmail = async (options) => {
  try {
		console.log("Email verify:", { to: options.to, templateId: options.templateId });
		const response = await axios.post(EMAIL_SERVICE_URL, options, {
			headers: { "Content-Type": "application/json" },
			timeout: 8000, // 8 seconds timeout
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
			templateId: 'AI_COMMUNICATION_WELCOME',
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
