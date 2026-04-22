/**
 * Attachment Controller
 *
 * Files are uploaded via the external File Upload Microservice.
 * This controller only registers the returned URL + file ID on the lead record.
 *
 * Expected body for POST /:id/attachments:
 *   { attachments: [{ fileId, filename, url, mimetype, size }] }
 *   OR a single object: { fileId, filename, url, mimetype, size }
 */
import Lead from '../../models/Lead.js';
import { catchAsync } from '../../middleware/errorHandler.js';
import { sendSuccess } from '../../utils/responseHelper.js';
import AppError from '../../utils/appError.js';

// POST /api/leads/:id/attachments
export const uploadAttachments = catchAsync(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, tenantId: req.tenantId, isDeleted: false });
  if (!lead) throw AppError.notFound('Lead not found');

  const incoming = Array.isArray(req.body.attachments) ? req.body.attachments : [req.body];
  if (!incoming.length || !incoming[0].fileId)
    throw AppError.badRequest('Provide attachments array with fileId, filename, and url');

  const existingIds = new Set(lead.attachments.map((a) => a.fileId));
  const added = [];

  for (const item of incoming) {
    if (!item.fileId || !item.url || !item.filename)
      throw AppError.badRequest('Each attachment must include fileId, url, and filename');
    if (existingIds.has(item.fileId)) continue;
    const entry = { fileId: item.fileId, filename: item.filename, url: item.url, mimetype: item.mimetype || null, size: item.size || null, uploadedAt: new Date(), uploadedBy: req.user.id };
    lead.attachments.push(entry);
    existingIds.add(item.fileId);
    added.push(entry);
  }

  await lead.save();
  return sendSuccess(res, { data: lead.attachments, message: `${added.length} attachment(s) registered` });
});

// DELETE /api/leads/:id/attachments/:fileId
export const deleteAttachment = catchAsync(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, tenantId: req.tenantId, isDeleted: false });
  if (!lead) throw AppError.notFound('Lead not found');

  const attachIndex = lead.attachments.findIndex((a) => String(a._id) === req.params.fileId);
  if (attachIndex === -1) throw AppError.notFound('Attachment not found');

  lead.attachments.splice(attachIndex, 1);
  await lead.save();
  return sendSuccess(res, { message: 'Attachment removed' });
});
