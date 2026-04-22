/**
 * Contract Controller
 * Handles: sendContract, signContract
 */
import * as leadService from '../../services/leadService.js';
import * as leadEmail from '../../services/leadEmailService.js';
import { catchAsync } from '../../middleware/errorHandler.js';
import { sendSuccess } from '../../utils/responseHelper.js';
import { config } from '../../config/index.js';

const DASH = config.dashboard.url;

// POST /api/leads/:id/contract
export const sendContract = catchAsync(async (req, res) => {
  const { contractUrl, message, attachmentName } = req.body;
  const lead = await leadService.sendContract(req.params.id, req.tenantId, { contractUrl, message, attachmentName }, req.user.id);
  leadEmail.sendContractEmail(lead, { contractUrl, message, agentName: req.user.email });
  return sendSuccess(res, { message: 'Contract sent' });
});

// PATCH /api/leads/:id/contract/signed
export const signContract = catchAsync(async (req, res) => {
  const { note, signedDate } = req.body;
  const lead = await leadService.signContract(req.params.id, req.tenantId, { note, signedDate }, req.user.id);
  const reviewUrl = `${DASH}/leads/${lead._id}`;
  leadEmail.sendContractSigned(lead, req.user.email);
  leadEmail.sendWonNotification(lead, { agentName: req.user.email, reviewUrl });
  return sendSuccess(res, { data: { status: 'won' }, message: 'Contract signed — lead marked as Won' });
});
