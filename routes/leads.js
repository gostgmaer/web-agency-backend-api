/**
 * Lead Routes
 *
 * CRITICAL — Route declaration order:
 * All static path segments (/stats, /export, /search, etc.) MUST be declared BEFORE /:id
 * to prevent Express from treating them as ID lookups.
 *
 * Mounted at: /api/leads
 */
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import adminAccess from '../middleware/adminAccess.js';
import { leadActivityLogger } from '../middleware/leadActivityLogger.js';
import { sanitizeInput } from '../middleware/leadSanitization.js';
import { leadRateLimit } from '../middleware/leadRateLimit.js';
import { setTenantFromUser, requireTenantHeader } from '../middleware/tenantMiddleware.js';
import { csvUpload, handleUploadErrors } from '../middleware/leadUpload.js';

import * as ctrl from '../controllers/leads/controller.js';
import * as proposalCtrl from '../controllers/leads/proposalController.js';
import * as contractCtrl from '../controllers/leads/contractController.js';
import * as attachCtrl from '../controllers/leads/attachmentController.js';
import * as importExportCtrl from '../controllers/leads/importExportController.js';

import {
  validateSubmitLead, validateBulkUpdate, validateAddNote, validateContactLead,
  validateSendProposal, validateReviseProposal, validateDeclineProposal,
  validateSendContract, validateMarkLost, validateHoldLead, validateReopenLead,
  validateStatusTransition, validateUpdateLead, validateSignContract,
  validateMarkWon, validateListQuery, validateAddAttachment,
} from '../validation/leadValidation.js';

const router = Router();

// ─── Rate limiters ────────────────────────────────────────────────────────────
const leadSubmitLimiter = leadRateLimit({ maxAttempts: 10, windowMs: 15 * 60 * 1000, action: 'lead_submit' });
const leadContactLimiter = leadRateLimit({ maxAttempts: 5, windowMs: 60 * 60 * 1000, action: 'lead_contact' });

// ─── Global middleware ────────────────────────────────────────────────────────
router.use(sanitizeInput);
router.use(leadActivityLogger({ skipSuccessfulGET: true }));

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES (no auth)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/health', ctrl.healthCheck);
router.post('/submit', leadSubmitLimiter, requireTenantHeader, validateSubmitLead, ctrl.submitLead);

// Proposal view tracking — PUBLIC (called from email link)
// MUST be declared before router.use(authenticate) below
router.get('/:id/proposal/view/:version', proposalCtrl.trackProposalView);

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATED ROUTES
// ─────────────────────────────────────────────────────────────────────────────

router.use(authenticate, setTenantFromUser);

// Stats & analytics (static — before /:id)
router.get('/stats', ctrl.getStats);
router.get('/proposals/stats', proposalCtrl.getProposalStats);
router.get('/proposals/expiring', proposalCtrl.getExpiringProposals);

// Listing & search
router.get('/', validateListQuery, ctrl.listLeads);
router.get('/export', ctrl.exportLeads);
router.get('/search', ctrl.searchLeads);
router.get('/follow-up', ctrl.getFollowUpLeads);

// Bulk operations
router.post('/bulk-update', validateBulkUpdate, ctrl.bulkUpdate);
router.post('/bulk-delete', validateBulkUpdate, ctrl.bulkDelete);

// CSV import
router.post('/import', csvUpload.single('file'), handleUploadErrors, importExportCtrl.importLeads);

// Admin-only static routes (before /:id)
router.get('/spam', adminAccess, ctrl.listSpam);
router.post('/proposals/expire-check', adminAccess, proposalCtrl.manualExpireCheck);

// ─────────────────────────────────────────────────────────────────────────────
// PARAM ROUTES — /:id  (after all static routes)
// ─────────────────────────────────────────────────────────────────────────────

// Core CRUD
router.get('/:id', ctrl.getLeadById);
router.patch('/:id', validateUpdateLead, ctrl.updateLead);
router.delete('/:id', ctrl.deleteLead);
router.get('/:id/score', ctrl.getLeadScore);

// Notes & communication
router.post('/:id/notes', validateAddNote, ctrl.addNote);
router.post('/:id/contact', leadContactLimiter, validateContactLead, ctrl.contactLead);

// Proposal lifecycle
router.post('/:id/proposal', validateSendProposal, proposalCtrl.sendProposal);
router.post('/:id/proposal/resend', proposalCtrl.resendProposal);
router.post('/:id/proposal/revise', validateReviseProposal, proposalCtrl.reviseProposal);
router.patch('/:id/proposal/accept', proposalCtrl.acceptProposal);
router.patch('/:id/proposal/decline', validateDeclineProposal, proposalCtrl.declineProposal);
router.get('/:id/proposal/history', proposalCtrl.getProposalHistory);
router.get('/:id/proposal/:version', proposalCtrl.getProposalVersion);

// Contract lifecycle
router.post('/:id/contract', validateSendContract, contractCtrl.sendContract);
router.patch('/:id/contract/signed', validateSignContract, contractCtrl.signContract);

// Status management
router.patch('/:id/status', validateStatusTransition, ctrl.updateStatus);
router.patch('/:id/hold', validateHoldLead, ctrl.holdLead);
router.patch('/:id/reopen', validateReopenLead, ctrl.reopenLead);
router.patch('/:id/won', validateMarkWon, ctrl.markWon);
router.patch('/:id/lost', validateMarkLost, ctrl.markLost);

// Attachments
router.post('/:id/attachments', validateAddAttachment, attachCtrl.uploadAttachments);
router.delete('/:id/attachments/:fileId', attachCtrl.deleteAttachment);

// Admin-only param routes
router.patch('/:id/spam', adminAccess, ctrl.toggleSpam);
router.delete('/:id/hard-delete', adminAccess, ctrl.hardDelete);
router.patch('/:id/reopen-admin', adminAccess, ctrl.reopenAdmin);

export default router;
