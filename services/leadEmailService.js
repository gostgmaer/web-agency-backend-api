/**
 * Lead Email Service
 *
 * RULES:
 * 1. This is the ONLY file that calls POST {EMAIL_SERVICE_URL}/send-email for lead templates.
 * 2. All functions return a Promise — callers MUST NOT await them (fire-and-forget).
 * 3. _dispatch logs errors internally — callers do not need to handle errors.
 */
import { apiCall } from '../lib/axiosCall.js';
import logger from '../utils/logger.js';
import { config } from '../config/index.js';
import {
  LEAD_RECEIVED, LEAD_ADMIN_NOTIFICATION, LEAD_CONTACT_REPLY, LEAD_STATUS_CHANGED,
  LEAD_FOLLOW_UP_REMINDER, PROJECT_PROPOSAL_EMAIL, LEAD_PROPOSAL_ACCEPTED,
  LEAD_ADMIN_PROPOSAL_ACCEPTED, LEAD_PROPOSAL_DECLINED_ACK, LEAD_ADMIN_PROPOSAL_DECLINED,
  LEAD_PROPOSAL_EXPIRING, LEAD_PROPOSAL_EXPIRED, LEAD_CONTRACT_SENT, LEAD_CONTRACT_SIGNED,
  LEAD_WON_NOTIFICATION, LEAD_LOST_NOTIFICATION,
} from '../email/leadEmailTemplate.js';

const URL   = config.email.serviceUrl;
const KEY   = config.emailApiKey;
const ADMIN = config.email.adminEmail;
const DASH  = config.dashboard.url;

function _dispatch(to, templateId, data) {
  return apiCall(
    `${URL}/send-email`,
    { method: 'POST', data: { to, templateId, data } },
    { headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' } }
  )
    .then((result) => {
      if (result?.error) logger.warn(`[leadEmail] ${templateId} → ${to} failed: ${result.message}`);
    })
    .catch((err) => {
      logger.error(`[leadEmail] ${templateId} → ${to} threw: ${err.message}`);
    });
}

// ─── Inbound / Submission ─────────────────────────────────────────────────────

export function sendLeadReceived(lead) {
  return _dispatch(lead.email, LEAD_RECEIVED, {
    firstName: lead.firstName, lastName: lead.lastName,
    leadNumber: lead.leadNumberFormatted, subject: lead.subject,
    projectType: lead.projectType, budget: lead.budget, timeline: lead.timeline,
  });
}

export function sendAdminLeadNotification(lead) {
  return _dispatch(ADMIN, LEAD_ADMIN_NOTIFICATION, {
    leadNumber: lead.leadNumberFormatted,
    firstName: lead.firstName, lastName: lead.lastName,
    email: lead.email, phone: lead.phone, company: lead.company,
    subject: lead.subject, message: lead.message,
    projectType: lead.projectType, budget: lead.budget, timeline: lead.timeline,
    source: lead.source, priority: lead.priority, score: lead.score,
    ipAddress: lead.ipAddress, submittedAt: lead.createdAt,
    reviewUrl: `${DASH}/leads/${lead._id}`,
  });
}

// ─── Communication ────────────────────────────────────────────────────────────

export function sendContactReply(lead, { subject, message, agentName, agentEmail, agentTitle }) {
  return _dispatch(lead.email, LEAD_CONTACT_REPLY, {
    firstName: lead.firstName, lastName: lead.lastName,
    leadNumber: lead.leadNumberFormatted, subject, message,
    agentName, agentEmail, agentTitle,
  });
}

export function sendStatusChanged(lead, { oldStatus, newStatus, note, agentName, ctaUrl }) {
  return _dispatch(lead.email, LEAD_STATUS_CHANGED, {
    firstName: lead.firstName, lastName: lead.lastName,
    leadNumber: lead.leadNumberFormatted, oldStatus, newStatus, note, agentName, ctaUrl,
  });
}

export function sendFollowUpReminder(agentEmail, lead, agent, { followUpDate, daysSinceLastContact, notes, reviewUrl }) {
  return _dispatch(agentEmail, LEAD_FOLLOW_UP_REMINDER, {
    agentName: agent?.firstName || agentEmail,
    leadNumber: lead.leadNumberFormatted,
    leadFirstName: lead.firstName, leadLastName: lead.lastName,
    leadEmail: lead.email, leadCompany: lead.company,
    priority: lead.priority, followUpDate, daysSinceLastContact, notes, reviewUrl,
  });
}

// ─── Proposal Lifecycle ───────────────────────────────────────────────────────

export function sendProposalEmail(lead, { proposalNumber, proposalUrl, quotedAmount, validUntil, message, attachmentName }) {
  return _dispatch(lead.email, PROJECT_PROPOSAL_EMAIL, {
    clientName: `${lead.firstName} ${lead.lastName}`,
    projectName: lead.subject, proposalUrl, proposalNumber,
    issueDate: new Date().toLocaleDateString(),
    validUntil, quotedAmount, message, attachmentName,
  });
}

export function sendProposalAccepted(lead, agentName) {
  return _dispatch(lead.email, LEAD_PROPOSAL_ACCEPTED, {
    firstName: lead.firstName, leadNumber: lead.leadNumberFormatted,
    projectName: lead.subject, quotedAmount: lead.quotedAmount,
    quotedCurrency: lead.quotedCurrency, agentName,
  });
}

export function sendAdminProposalAccepted(lead, reviewUrl) {
  return _dispatch(ADMIN, LEAD_ADMIN_PROPOSAL_ACCEPTED, {
    leadNumber: lead.leadNumberFormatted,
    firstName: lead.firstName, lastName: lead.lastName,
    email: lead.email, company: lead.company,
    projectName: lead.subject, quotedAmount: lead.quotedAmount, reviewUrl,
  });
}

export function sendProposalDeclinedAck(lead, agentName) {
  return _dispatch(lead.email, LEAD_PROPOSAL_DECLINED_ACK, {
    firstName: lead.firstName, leadNumber: lead.leadNumberFormatted,
    projectName: lead.subject, agentName, supportEmail: ADMIN,
  });
}

export function sendAdminProposalDeclined(lead, { declinedReason, reviewUrl }) {
  return _dispatch(ADMIN, LEAD_ADMIN_PROPOSAL_DECLINED, {
    leadNumber: lead.leadNumberFormatted,
    firstName: lead.firstName, lastName: lead.lastName,
    email: lead.email, company: lead.company, declinedReason, reviewUrl,
  });
}

export function sendProposalExpiringSoon(lead, { proposalNumber, validUntil, daysRemaining, reviewUrl }) {
  return _dispatch(ADMIN, LEAD_PROPOSAL_EXPIRING, {
    leadNumber: lead.leadNumberFormatted,
    firstName: lead.firstName, lastName: lead.lastName,
    email: lead.email, proposalNumber, validUntil, daysRemaining, reviewUrl,
  });
}

export function sendProposalExpired(lead, { proposalNumber, expiredAt, reviewUrl }) {
  return _dispatch(ADMIN, LEAD_PROPOSAL_EXPIRED, {
    leadNumber: lead.leadNumberFormatted,
    firstName: lead.firstName, lastName: lead.lastName,
    email: lead.email, proposalNumber, expiredAt, reviewUrl,
  });
}

// ─── Contract Lifecycle ───────────────────────────────────────────────────────

export function sendContractEmail(lead, { contractUrl, message, agentName }) {
  return _dispatch(lead.email, LEAD_CONTRACT_SENT, {
    firstName: lead.firstName, leadNumber: lead.leadNumberFormatted,
    projectName: lead.subject, contractUrl, message, agentName,
  });
}

export function sendContractSigned(lead, agentName) {
  _dispatch(lead.email, LEAD_CONTRACT_SIGNED, {
    firstName: lead.firstName, leadNumber: lead.leadNumberFormatted,
    projectName: lead.subject, contractSignedAt: lead.contractSignedAt, agentName,
  });
  _dispatch(ADMIN, LEAD_CONTRACT_SIGNED, {
    firstName: lead.firstName, leadNumber: lead.leadNumberFormatted,
    projectName: lead.subject, contractSignedAt: lead.contractSignedAt, agentName,
  });
}

// ─── Deal Outcome ─────────────────────────────────────────────────────────────

export function sendWonNotification(lead, { agentName, reviewUrl }) {
  return _dispatch(ADMIN, LEAD_WON_NOTIFICATION, {
    leadNumber: lead.leadNumberFormatted,
    firstName: lead.firstName, lastName: lead.lastName,
    email: lead.email, company: lead.company, projectName: lead.subject,
    quotedAmount: lead.quotedAmount, quotedCurrency: lead.quotedCurrency,
    closedAt: new Date(), agentName, reviewUrl,
  });
}

export function sendLostNotification(lead, { lostReason, agentName, reviewUrl }) {
  return _dispatch(ADMIN, LEAD_LOST_NOTIFICATION, {
    leadNumber: lead.leadNumberFormatted,
    firstName: lead.firstName, lastName: lead.lastName,
    email: lead.email, company: lead.company, lostReason, agentName, reviewUrl,
  });
}
