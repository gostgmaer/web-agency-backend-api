/**
 * Lead Scheduler Service
 * Cron jobs for proposal expiry, follow-up reminders, and hold-resume automation.
 */
import cron from 'node-cron';
import Lead from '../models/Lead.js';
import * as leadService from './leadService.js';
import * as leadEmail from './leadEmailService.js';
import logger from '../utils/logger.js';
import { config } from '../config/index.js';

const DASH = config.dashboard.url;

// ─── Distributed lock (Redis optional, in-process fallback) ──────────────────

let redisLock = null;

if (config.redis?.enabled && config.redis?.url) {
  try {
    const { default: Redis } = await import('ioredis');
    redisLock = new Redis(config.redis.url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: true });
    redisLock.connect().catch(() => { redisLock = null; });
    redisLock.on('error', () => { redisLock = null; });
  } catch (_) {
    redisLock = null;
  }
}

const runningJobs = new Set();

async function acquireLock(jobName, ttlSeconds = 300) {
  if (redisLock) {
    const result = await redisLock.set(`scheduler:lock:${jobName}`, '1', 'NX', 'EX', ttlSeconds).catch(() => null);
    return result === 'OK';
  }
  if (runningJobs.has(jobName)) return false;
  runningJobs.add(jobName);
  return true;
}

async function releaseLock(jobName) {
  if (redisLock) { await redisLock.del(`scheduler:lock:${jobName}`).catch(() => {}); }
  else { runningJobs.delete(jobName); }
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

export async function runProposalExpiryCheck() {
  logger.info('[scheduler] Running proposal expiry check');
  try {
    const leads = await Lead.find({ isDeleted: false, status: { $in: ['proposal_sent', 'proposal_viewed'] }, proposalExpiresAt: { $lt: new Date() } });
    for (const lead of leads) {
      try {
        await leadService.expireProposal(lead);
        logger.info(`[scheduler] Expired proposal for lead ${lead.leadNumberFormatted}`);
      } catch (err) {
        logger.error(`[scheduler] Failed to expire proposal for ${lead._id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[scheduler] Proposal expiry check failed: ${err.message}`);
  }
}

export async function runProposalExpirySoonAlert() {
  logger.info('[scheduler] Running proposal expiry soon alert');
  try {
    const now = new Date();
    const in7 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const leads = await Lead.find({ isDeleted: false, status: { $in: ['proposal_sent', 'proposal_viewed'] }, proposalExpiresAt: { $gte: now, $lte: in7 } });
    for (const lead of leads) {
      const entry = lead.proposals[lead.activeProposalVersion - 1];
      if (!entry) continue;
      const daysRemaining = Math.ceil((new Date(lead.proposalExpiresAt) - now) / 86400000);
      leadEmail.sendProposalExpiringSoon(lead, { proposalNumber: entry.proposalNumber, validUntil: lead.proposalExpiresAt, daysRemaining, reviewUrl: `${DASH}/leads/${lead._id}` });
    }
  } catch (err) {
    logger.error(`[scheduler] Proposal expiry-soon alert failed: ${err.message}`);
  }
}

export async function runFollowUpReminders() {
  logger.info('[scheduler] Running follow-up reminders');
  try {
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    const leads = await Lead.find({ isDeleted: false, nextFollowUp: { $lte: today }, status: { $nin: ['won', 'lost', 'archived', 'disqualified'] }, assignedTo: { $exists: true } }).populate('assignedTo', 'firstName lastName email');
    for (const lead of leads) {
      try {
        const agent = lead.assignedTo;
        if (!agent || !agent.email) continue;
        const daysSince = lead.lastContactedAt ? Math.ceil((Date.now() - new Date(lead.lastContactedAt)) / 86400000) : null;
        leadEmail.sendFollowUpReminder(agent.email, lead, agent, { followUpDate: lead.nextFollowUp, daysSinceLastContact: daysSince, notes: lead.notes.slice(-3).map((n) => n.content).join(' | '), reviewUrl: `${DASH}/leads/${lead._id}` });
      } catch (err) {
        logger.error(`[scheduler] Follow-up reminder failed for ${lead._id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[scheduler] Follow-up reminders failed: ${err.message}`);
  }
}

export async function runHoldResumeCheck() {
  logger.info('[scheduler] Running hold resume check');
  try {
    const leads = await Lead.find({ isDeleted: false, status: 'on_hold', resumeDate: { $lte: new Date() } });
    for (const lead of leads) {
      try {
        lead.resumeDate = null;
        await leadService.updateLeadStatus(lead, 'new', 'Auto-reopened by scheduler', null);
        logger.info(`[scheduler] Auto-reopened lead ${lead.leadNumberFormatted}`);
      } catch (err) {
        logger.error(`[scheduler] Failed to auto-reopen ${lead._id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[scheduler] Hold resume check failed: ${err.message}`);
  }
}

export function startScheduler() {
  // Every hour — proposal expiry + hold resume
  cron.schedule('0 * * * *', async () => {
    if (await acquireLock('proposal_expiry', 3600)) {
      try { await runProposalExpiryCheck(); } finally { await releaseLock('proposal_expiry'); }
    }
    if (await acquireLock('hold_resume', 3600)) {
      try { await runHoldResumeCheck(); } finally { await releaseLock('hold_resume'); }
    }
  });

  // Daily at 8am — follow-up reminders
  cron.schedule('0 8 * * *', async () => {
    if (await acquireLock('follow_up_reminders', 3600)) {
      try { await runFollowUpReminders(); } finally { await releaseLock('follow_up_reminders'); }
    }
  });

  // Daily at 9am — expiry-soon alerts
  cron.schedule('0 9 * * *', async () => {
    if (await acquireLock('proposal_expiry_soon', 3600)) {
      try { await runProposalExpirySoonAlert(); } finally { await releaseLock('proposal_expiry_soon'); }
    }
  });

  logger.info('[scheduler] Lead cron jobs started');
}
