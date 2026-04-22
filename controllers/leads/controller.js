/**
 * Core Lead Controller
 * Handles: submit, list, get, update, delete, status, hold, reopen, won, lost, notes, score, spam, bulk ops
 */
import * as leadService from '../../services/leadService.js';
import * as leadEmail from '../../services/leadEmailService.js';
import Lead from '../../models/Lead.js';
import { catchAsync } from '../../middleware/errorHandler.js';
import { sendSuccess, sendCreated, sendPaginated } from '../../utils/responseHelper.js';
import { apiCall } from '../../lib/axiosCall.js';
import { config } from '../../config/index.js';
import mongoose from 'mongoose';

const DASH = config.dashboard.url;

// POST /api/leads/submit  — public
export const submitLead = catchAsync(async (req, res) => {
  const lead = await leadService.createLead(req.body, req.tenantId, {
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    source: req.body.source || 'website',
  });

  if (lead.isSpam) return res.status(200).json({ success: true, message: 'Inquiry received' });

  leadEmail.sendLeadReceived(lead);
  leadEmail.sendAdminLeadNotification(lead);

  return sendCreated(res, {
    data: { leadNumber: lead.leadNumberFormatted },
    message: 'Inquiry received. We will get back to you shortly.',
  });
});

// GET /api/leads
export const listLeads = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, status, priority, source, sort = 'createdAt', order = 'desc', assignedTo } = req.query;
  const result = await leadService.getLeads(req.tenantId, {
    page: parseInt(page), limit: parseInt(limit), status, priority, source, sort, order, assignedTo,
  });
  return sendPaginated(res, {
    docs: result.docs,
    message: 'Leads retrieved successfully',
    page: result.page,
    pageSize: result.limit,
    totalRecords: result.total,
    totalPages: result.pages,
    hasNext: result.hasNext,
    hasPrev: result.hasPrev,
  });
});

// GET /api/leads/stats
export const getStats = catchAsync(async (req, res) => {
  const stats = await leadService.getLeadStats(req.tenantId);
  return sendSuccess(res, { data: stats, message: 'Stats retrieved' });
});

// GET /api/leads/export
export const exportLeads = catchAsync(async (req, res) => {
  const { Parser } = await import('json2csv');
  const rows = await Lead.exportToCSV(req.tenantId, {});
  const parser = new Parser();
  const csv = parser.parse(rows);
  res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename=leads-${new Date().toISOString().split('T')[0]}.csv` });
  return res.status(200).send(csv);
});

// GET /api/leads/search
export const searchLeads = catchAsync(async (req, res) => {
  const { q, status, priority, source, tags, dateFrom, dateTo, assignedTo } = req.query;
  const leads = await Lead.searchLeads({ tenantId: req.tenantId, q, status, priority, source, tags, dateFrom, dateTo, assignedTo });
  return sendSuccess(res, { data: leads, message: 'Search results' });
});

// GET /api/leads/follow-up
export const getFollowUpLeads = catchAsync(async (req, res) => {
  const leads = await Lead.findDueForFollowUp(req.tenantId);
  return sendSuccess(res, { data: leads, message: 'Follow-up leads' });
});

// GET /api/leads/:id
export const getLeadById = catchAsync(async (req, res) => {
  const lead = await leadService.getLeadById(req.params.id, req.tenantId);
  return sendSuccess(res, { data: lead, message: 'Lead retrieved' });
});

// PATCH /api/leads/:id
export const updateLead = catchAsync(async (req, res) => {
  const lead = await leadService.updateLead(req.params.id, req.tenantId, req.body, req.user.id);
  return sendSuccess(res, { data: lead, message: 'Lead updated' });
});

// DELETE /api/leads/:id
export const deleteLead = catchAsync(async (req, res) => {
  await leadService.softDeleteLead(req.params.id, req.tenantId, req.user.id);
  return sendSuccess(res, { message: 'Lead deleted' });
});

// GET /api/leads/:id/score
export const getLeadScore = catchAsync(async (req, res) => {
  const lead = await leadService.getLeadById(req.params.id, req.tenantId);
  const updated = await leadService.computeAndSaveScore(lead);
  return sendSuccess(res, { data: { score: updated.score }, message: 'Score computed' });
});

// POST /api/leads/:id/notes
export const addNote = catchAsync(async (req, res) => {
  const { content, isInternal } = req.body;
  const lead = await leadService.addNote(req.params.id, req.tenantId, content, isInternal, req.user.id);
  return sendSuccess(res, { data: lead.notes, message: 'Note added' });
});

// POST /api/leads/:id/contact
export const contactLead = catchAsync(async (req, res) => {
  const { subject, message } = req.body;
  const lead = await leadService.getLeadById(req.params.id, req.tenantId);
  leadEmail.sendContactReply(lead, {
    subject, message,
    agentName: req.user.name || req.user.email,
    agentEmail: req.user.email,
    agentTitle: req.user.jobTitle,
  });
  await leadService.updateLeadStatus(lead, 'contacted', `Contacted by ${req.user.email}`, req.user.id);
  return sendSuccess(res, { message: 'Email sent and lead status updated' });
});

// PATCH /api/leads/:id/status
export const updateStatus = catchAsync(async (req, res) => {
  const { status: newStatus, note } = req.body;
  const lead = await leadService.getLeadById(req.params.id, req.tenantId);
  const oldStatus = lead.status;
  await leadService.updateLeadStatus(lead, newStatus, note, req.user.id);
  return sendSuccess(res, { data: { oldStatus, newStatus }, message: 'Status updated' });
});

// PATCH /api/leads/:id/hold
export const holdLead = catchAsync(async (req, res) => {
  const { onHoldReason, resumeDate } = req.body;
  await leadService.putOnHold(req.params.id, req.tenantId, { onHoldReason, resumeDate }, req.user.id);
  return sendSuccess(res, { message: 'Lead put on hold' });
});

// PATCH /api/leads/:id/reopen
export const reopenLead = catchAsync(async (req, res) => {
  const { note } = req.body;
  await leadService.reopenLead(req.params.id, req.tenantId, { note }, req.user.id);
  return sendSuccess(res, { message: 'Lead reopened' });
});

// PATCH /api/leads/:id/won
export const markWon = catchAsync(async (req, res) => {
  const { note, closedRevenue } = req.body;
  const lead = await leadService.markWon(req.params.id, req.tenantId, { note, closedRevenue }, req.user.id);
  leadEmail.sendWonNotification(lead, { agentName: req.user.email, reviewUrl: `${DASH}/leads/${lead._id}` });
  return sendSuccess(res, { message: 'Lead marked as won' });
});

// PATCH /api/leads/:id/lost
export const markLost = catchAsync(async (req, res) => {
  const { lostReason, note } = req.body;
  const lead = await leadService.markLost(req.params.id, req.tenantId, { lostReason, note }, req.user.id);
  leadEmail.sendLostNotification(lead, { lostReason, agentName: req.user.email, reviewUrl: `${DASH}/leads/${lead._id}` });
  return sendSuccess(res, { message: 'Lead marked as lost' });
});

// POST /api/leads/bulk-update
export const bulkUpdate = catchAsync(async (req, res) => {
  const { ids, ...updates } = req.body;
  await Lead.bulkUpdateStatus(ids, updates, req.user.id);
  return sendSuccess(res, { message: `${ids.length} leads updated` });
});

// POST /api/leads/bulk-delete
export const bulkDelete = catchAsync(async (req, res) => {
  const { ids } = req.body;
  await Lead.bulkUpdateStatus(ids, { isDeleted: true, deletedAt: new Date(), deletedBy: req.user.id }, req.user.id);
  return sendSuccess(res, { message: `${ids.length} leads deleted` });
});

// GET /api/leads/spam
export const listSpam = catchAsync(async (req, res) => {
  const leads = await Lead.find({ tenantId: req.tenantId, isSpam: true }).sort({ createdAt: -1 });
  return sendSuccess(res, { data: leads, message: 'Spam leads' });
});

// PATCH /api/leads/:id/spam
export const toggleSpam = catchAsync(async (req, res) => {
  const lead = await leadService.toggleSpam(req.params.id, req.tenantId, req.user.id);
  return sendSuccess(res, { data: { isSpam: lead.isSpam }, message: 'Spam flag toggled' });
});

// DELETE /api/leads/:id/hard-delete  — redirected to soft-delete
export const hardDelete = catchAsync(async (req, res) => {
  await leadService.softDeleteLead(req.params.id, req.tenantId, req.user.id);
  return sendSuccess(res, { message: 'Lead deleted' });
});

// PATCH /api/leads/:id/reopen-admin  (admin)
export const reopenAdmin = catchAsync(async (req, res) => {
  const { note } = req.body;
  await leadService.forceReopenAdmin(req.params.id, req.tenantId, { note }, req.user.id);
  return sendSuccess(res, { message: 'Lead force-reopened by admin' });
});

// GET /api/leads/health
export const healthCheck = catchAsync(async (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'ok' : 'down';
  let emailStatus = 'unknown';
  const result = await apiCall(`${config.email.serviceUrl}/health`, { method: 'GET' }, { timeout: 3000 });
  emailStatus = result.error ? 'degraded' : 'ok';
  return res.status(200).json({
    status: 'ok',
    service: 'web-agency-backend-api',
    timestamp: new Date().toISOString(),
    dependencies: { database: dbStatus, emailService: emailStatus },
  });
});
