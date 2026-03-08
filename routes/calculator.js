import express from 'express';
import { validateRequest } from '../middleware/validation.js';
import { estimateValidation } from '../validation/calculatorValidation.js';
import { BadRequestError } from '../utils/errors.js';

const router = express.Router();

// ─── Cost profiles per project type × complexity ─────────────────────────────
// Each "ratio" pack must sum to 1.00.  maintenanceRate is % of project cost/year.
const PROFILES = {
  website: {
    basic: {
      description: 'Simple informational / brochure website (3–7 pages, no backend logic)',
      ratios: { design: 0.25, frontend: 0.40, backend: 0.08, testing: 0.10, projectManagement: 0.10, deployment: 0.07 },
      maintenanceRate: 0.15,
      timeline: { min: 1, max: 2 },
    },
    standard: {
      description: 'Business website with CMS, contact forms & basic integrations (8–20 pages)',
      ratios: { design: 0.20, frontend: 0.35, backend: 0.20, testing: 0.10, projectManagement: 0.10, deployment: 0.05 },
      maintenanceRate: 0.18,
      timeline: { min: 2, max: 4 },
    },
    advanced: {
      description: 'Feature-rich website with custom APIs, third-party integrations (20+ pages)',
      ratios: { design: 0.18, frontend: 0.30, backend: 0.27, testing: 0.12, projectManagement: 0.09, deployment: 0.04 },
      maintenanceRate: 0.20,
      timeline: { min: 3, max: 6 },
    },
    enterprise: {
      description: 'High-traffic enterprise platform with microservices & CDN infrastructure',
      ratios: { design: 0.15, frontend: 0.25, backend: 0.35, testing: 0.15, projectManagement: 0.08, deployment: 0.02 },
      maintenanceRate: 0.22,
      timeline: { min: 6, max: 12 },
    },
  },
  webapp: {
    basic: {
      description: 'Simple CRUD web application with authentication (1–3 core modules)',
      ratios: { design: 0.15, frontend: 0.30, backend: 0.35, testing: 0.10, projectManagement: 0.06, deployment: 0.04 },
      maintenanceRate: 0.18,
      timeline: { min: 2, max: 4 },
    },
    standard: {
      description: 'Multi-module web app with roles, dashboard & API integrations',
      ratios: { design: 0.12, frontend: 0.28, backend: 0.38, testing: 0.12, projectManagement: 0.07, deployment: 0.03 },
      maintenanceRate: 0.20,
      timeline: { min: 3, max: 6 },
    },
    advanced: {
      description: 'Complex SaaS platform with real-time features, analytics & multi-tenancy',
      ratios: { design: 0.10, frontend: 0.25, backend: 0.42, testing: 0.13, projectManagement: 0.07, deployment: 0.03 },
      maintenanceRate: 0.22,
      timeline: { min: 5, max: 8 },
    },
    enterprise: {
      description: 'Enterprise SaaS with microservices, Kafka, dedicated infra & SLA guarantees',
      ratios: { design: 0.10, frontend: 0.22, backend: 0.45, testing: 0.15, projectManagement: 0.06, deployment: 0.02 },
      maintenanceRate: 0.25,
      timeline: { min: 9, max: 18 },
    },
  },
  ecommerce: {
    basic: {
      description: 'Catalogue store with cart, checkout & single payment gateway (< 500 SKUs)',
      ratios: { design: 0.20, frontend: 0.32, backend: 0.28, testing: 0.10, projectManagement: 0.06, deployment: 0.04 },
      maintenanceRate: 0.20,
      timeline: { min: 2, max: 4 },
    },
    standard: {
      description: 'Full e-commerce with inventory, multiple payment gateways & seller dashboard',
      ratios: { design: 0.18, frontend: 0.28, backend: 0.33, testing: 0.12, projectManagement: 0.06, deployment: 0.03 },
      maintenanceRate: 0.22,
      timeline: { min: 4, max: 7 },
    },
    advanced: {
      description: 'Multi-vendor marketplace with logistics, analytics & subscription billing',
      ratios: { design: 0.15, frontend: 0.25, backend: 0.38, testing: 0.13, projectManagement: 0.07, deployment: 0.02 },
      maintenanceRate: 0.24,
      timeline: { min: 6, max: 10 },
    },
    enterprise: {
      description: 'Enterprise retail platform with ERP integration, AI recommendations & global CDN',
      ratios: { design: 0.12, frontend: 0.22, backend: 0.42, testing: 0.15, projectManagement: 0.07, deployment: 0.02 },
      maintenanceRate: 0.26,
      timeline: { min: 10, max: 18 },
    },
  },
  mobile: {
    basic: {
      description: 'Simple mobile app (iOS or Android) — informational or utility, 3–5 screens',
      ratios: { design: 0.25, frontend: 0.42, backend: 0.15, testing: 0.10, projectManagement: 0.05, deployment: 0.03 },
      maintenanceRate: 0.18,
      timeline: { min: 2, max: 4 },
    },
    standard: {
      description: 'Cross-platform app (React Native / Flutter) with backend, push notifications & auth',
      ratios: { design: 0.22, frontend: 0.38, backend: 0.22, testing: 0.11, projectManagement: 0.05, deployment: 0.02 },
      maintenanceRate: 0.20,
      timeline: { min: 3, max: 6 },
    },
    advanced: {
      description: 'Feature-rich mobile app with real-time data, payments, in-app purchases & analytics',
      ratios: { design: 0.18, frontend: 0.33, backend: 0.30, testing: 0.12, projectManagement: 0.05, deployment: 0.02 },
      maintenanceRate: 0.22,
      timeline: { min: 5, max: 9 },
    },
    enterprise: {
      description: 'Enterprise mobility solution with offline-first architecture, MDM & strict SLA',
      ratios: { design: 0.14, frontend: 0.28, backend: 0.38, testing: 0.13, projectManagement: 0.05, deployment: 0.02 },
      maintenanceRate: 0.25,
      timeline: { min: 8, max: 15 },
    },
  },
  other: {
    basic:      { description: 'Small custom software project',  ratios: { design: 0.20, frontend: 0.30, backend: 0.28, testing: 0.10, projectManagement: 0.07, deployment: 0.05 }, maintenanceRate: 0.18, timeline: { min: 2, max: 4 } },
    standard:   { description: 'Medium custom software project', ratios: { design: 0.18, frontend: 0.28, backend: 0.32, testing: 0.12, projectManagement: 0.07, deployment: 0.03 }, maintenanceRate: 0.20, timeline: { min: 3, max: 6 } },
    advanced:   { description: 'Large custom software project',  ratios: { design: 0.15, frontend: 0.25, backend: 0.37, testing: 0.13, projectManagement: 0.07, deployment: 0.03 }, maintenanceRate: 0.22, timeline: { min: 5, max: 10 } },
    enterprise: { description: 'Enterprise custom platform',     ratios: { design: 0.12, frontend: 0.22, backend: 0.42, testing: 0.14, projectManagement: 0.07, deployment: 0.03 }, maintenanceRate: 0.25, timeline: { min: 8, max: 18 } },
  },
};

// ─── What each category includes ─────────────────────────────────────────────
const CATEGORY_DETAILS = {
  design:            { label: 'UI/UX Design',            includes: ['User research & wireframing', 'High-fidelity mockups', 'Interactive prototype', 'Design system / style guide', 'Responsive layouts'] },
  frontend:          { label: 'Frontend Development',    includes: ['Component library setup', 'Pixel-perfect implementation', 'Responsive & cross-browser CSS', 'State management', 'Animations & micro-interactions', 'Accessibility (WCAG 2.1)'] },
  backend:           { label: 'Backend Development',     includes: ['REST API design & development', 'Database schema & migrations', 'Authentication & authorisation', 'Business logic & integrations', 'Email / notification services'] },
  testing:           { label: 'Testing & QA',            includes: ['Unit & integration tests', 'End-to-end testing', 'Cross-browser & device testing', 'Performance & load testing', 'Security vulnerability scan'] },
  projectManagement: { label: 'Project Management',      includes: ['Requirements gathering', 'Sprint planning & Agile ceremonies', 'Progress reporting', 'Stakeholder communication', 'Documentation & handover'] },
  deployment:        { label: 'Deployment & DevOps',     includes: ['CI/CD pipeline setup', 'Server provisioning', 'SSL certificate & domain setup', 'Monitoring & alerting', 'Backup strategy'] },
};

// ─── Annual maintenance sub-breakdown (% of annual maintenance cost) ─────────
const MAINTENANCE_BREAKDOWN = {
  bugFixes:             { label: 'Bug Fixes & Code Updates',        pct: 0.35 },
  securityPatches:      { label: 'Security Patches & Audits',       pct: 0.20 },
  performanceMonitor:   { label: 'Performance Monitoring & Tuning', pct: 0.15 },
  contentUpdates:       { label: 'Content & Feature Updates',       pct: 0.15 },
  support:              { label: 'Technical Support',               pct: 0.10 },
  backups:              { label: 'Backups & Disaster Recovery',     pct: 0.05 },
};

// ─── Server / hosting tiers ───────────────────────────────────────────────────
// Costs in INR per month — ranges represent [min, max] for realistic invoicing.
const SERVER_TIERS = [
  {
    tier:        'Shared Hosting',
    suitableFor: 'Static / brochure websites with low traffic (< 5k visits/month)',
    monthly:     { min: 200,   max: 600   },
    specs:       '1–2 vCPU · 1–2 GB RAM · 10–50 GB SSD · Shared bandwidth',
    providers:   ['Hostinger', 'SiteGround', 'Bluehost', 'BigRock'],
    limitations: ['No root access', 'Shared resources', 'Limited scalability'],
    bestFor:     ['Brochure websites', 'Landing pages', 'Personal blogs'],
  },
  {
    tier:        'VPS (Virtual Private Server)',
    suitableFor: 'Growing websites & web apps with moderate traffic (5k–100k visits/month)',
    monthly:     { min: 800,   max: 3000  },
    specs:       '2–4 vCPU · 4–8 GB RAM · 80–200 GB SSD · Dedicated bandwidth',
    providers:   ['DigitalOcean', 'Linode', 'Vultr', 'Hetzner'],
    limitations: ['Manual server management required', 'Vertical scaling limit'],
    bestFor:     ['Business websites', 'Small web apps', 'E-commerce (< 1k orders/day)'],
  },
  {
    tier:        'Cloud (Auto-scaling)',
    suitableFor: 'High-traffic platforms & SaaS products (100k+ visits/month)',
    monthly:     { min: 3000,  max: 15000 },
    specs:       '4–16 vCPU · 8–32 GB RAM · Managed DB · CDN included · Auto-scale',
    providers:   ['AWS', 'Google Cloud', 'Azure', 'Vercel + Railway'],
    limitations: ['Usage-based billing can spike', 'Requires cloud expertise'],
    bestFor:     ['Web apps', 'SaaS platforms', 'E-commerce (high volume)', 'Mobile backend'],
  },
  {
    tier:        'Dedicated / Bare Metal',
    suitableFor: 'Enterprise workloads requiring guaranteed resources & compliance',
    monthly:     { min: 12000, max: 50000 },
    specs:       '8–32 vCPU · 32–256 GB RAM · NVMe SSD · 1 Gbps port · DDoS protection',
    providers:   ['AWS EC2 Dedicated', 'OVHcloud', 'Hetzner Dedicated', 'Tata IQ'],
    limitations: ['High fixed cost', 'Requires DevOps team'],
    bestFor:     ['Enterprise platforms', 'Financial / healthcare apps', 'High compliance workloads'],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const round = (n) => Math.round(n);

function buildProjectBreakdown(total, ratios) {
  const items = [];
  let allocated = 0;
  const keys = Object.keys(ratios);

  keys.forEach((key, idx) => {
    // Last item gets remainder to avoid rounding drift
    const amount = idx === keys.length - 1 ? total - allocated : round(total * ratios[key]);
    allocated += amount;
    const detail = CATEGORY_DETAILS[key];
    items.push({
      category:   detail.label,
      key,
      percentage: round(ratios[key] * 100),
      amount,
      includes:   detail.includes,
    });
  });

  return { total, items };
}

function buildMaintenancePlan(projectTotal, annualRate, currency) {
  // Year-over-year maintenance grows at 5% (inflation + complexity drift)
  const ANNUAL_GROWTH = 0.05;
  const baseAnnual = round(projectTotal * annualRate);

  function yearAmount(yearIndex) {
    return round(baseAnnual * Math.pow(1 + ANNUAL_GROWTH, yearIndex));
  }

  function buildYearBreakdown(amount) {
    return Object.entries(MAINTENANCE_BREAKDOWN).map(([key, v]) => ({
      category: v.label,
      key,
      percentage: round(v.pct * 100),
      amount: round(amount * v.pct),
    }));
  }

  function buildPlan(years) {
    let totalCost = 0;
    const yearlySchedule = [];
    for (let y = 0; y < years; y++) {
      const amt = yearAmount(y);
      totalCost += amt;
      yearlySchedule.push({
        year:    y + 1,
        annual:  amt,
        monthly: round(amt / 12),
        breakdown: buildYearBreakdown(amt),
      });
    }
    return {
      years,
      totalCost,
      averageMonthly: round(totalCost / (years * 12)),
      yearlySchedule,
    };
  }

  return {
    annualRate:          `${round(annualRate * 100)}%`,
    baseAnnualCost:      baseAnnual,
    baseMonthlyAverage:  round(baseAnnual / 12),
    note:                `Maintenance starts at ${round(annualRate * 100)}% of project cost per year. A 5% annual growth factor accounts for inflation and increasing codebase complexity.`,
    breakdown:           buildYearBreakdown(baseAnnual),
    plans: {
      '1year': buildPlan(1),
      '3year': buildPlan(3),
      '5year': buildPlan(5),
    },
  };
}

function buildServerCosts(tiers) {
  return tiers.map((t) => ({
    ...t,
    yearly:  { min: t.monthly.min * 12,  max: t.monthly.max * 12  },
    '3year': { min: t.monthly.min * 36,  max: t.monthly.max * 36  },
    '5year': { min: t.monthly.min * 60,  max: t.monthly.max * 60  },
  }));
}

function buildTotalCostOfOwnership(projectTotal, maintenancePlans, serverTiers) {
  function forHorizon(horizonKey, years) {
    const maint = maintenancePlans.plans[horizonKey].totalCost;
    const scenarios = serverTiers.map((t) => {
      const serverKey = horizonKey === '1year' ? 'yearly' : horizonKey;
      return {
        tier:     t.tier,
        serverCost: t[serverKey],
        totalMin: projectTotal + maint + t[serverKey].min,
        totalMax: projectTotal + maint + t[serverKey].max,
      };
    });
    return { years, projectCost: projectTotal, maintenanceCost: maint, scenarios };
  }

  return {
    '1year': forHorizon('1year', 1),
    '3year': forHorizon('3year', 3),
    '5year': forHorizon('5year', 5),
  };
}

// ─── Route ────────────────────────────────────────────────────────────────────

/**
 * POST /api/calculator/estimate
 *
 * Accepts one of three input shapes:
 *   1. { amount, projectType?, complexityLevel?, currency?, projectName? }
 *   2. { customBreakdown: { design, frontend, backend, ... }, maintRate?, currency? }
 *   3. Both — customBreakdown overrides the profile ratios (amount is still required for server/maintenance)
 */
router.post('/estimate', estimateValidation, validateRequest, (req, res, next) => {
  try {
    const {
      amount,
      currency       = 'INR',
      projectType    = 'website',
      complexityLevel = 'standard',
      projectName    = 'Your Project',
      customBreakdown,
    } = req.body;

    // Validate we have something to work with
    if (amount == null && customBreakdown == null) {
      throw new BadRequestError(
        'Provide either "amount" (number) or "customBreakdown" (object with cost keys).'
      );
    }

    // ── Derive total amount ────────────────────────────────────────────────
    let total;
    if (customBreakdown) {
      total = Object.values(customBreakdown).reduce((s, v) => s + (Number(v) || 0), 0);
      if (total <= 0) throw new BadRequestError('customBreakdown values must sum to a positive number.');
    } else {
      total = round(Number(amount));
    }

    // ── Pick profile ───────────────────────────────────────────────────────
    const profileGroup = PROFILES[projectType] ?? PROFILES.website;
    const profile      = profileGroup[complexityLevel] ?? profileGroup.standard;

    // ── Build ratios either from profile or from customBreakdown ──────────
    let ratios;
    if (customBreakdown) {
      const sum = Object.values(customBreakdown).reduce((s, v) => s + (Number(v) || 0), 0);
      ratios = {};
      for (const [k, v] of Object.entries(customBreakdown)) {
        if (CATEGORY_DETAILS[k]) ratios[k] = Number(v) / sum;
      }
      // Fill missing categories with 0 so CATEGORY_DETAILS labels still appear
      for (const k of Object.keys(CATEGORY_DETAILS)) {
        if (ratios[k] == null) ratios[k] = 0;
      }
    } else {
      ratios = profile.ratios;
    }

    // ── Sections ──────────────────────────────────────────────────────────
    const projectBreakdown = buildProjectBreakdown(total, ratios);
    const maintenancePlans = buildMaintenancePlan(total, profile.maintenanceRate, currency);
    const serverCosts      = buildServerCosts(SERVER_TIERS);
    const tco              = buildTotalCostOfOwnership(total, maintenancePlans, serverCosts);

    // ── Recommended scenario ───────────────────────────────────────────────
    // Pick "best" server tier by project type
    const tierIndexMap = { website: 0, webapp: 1, ecommerce: 1, mobile: 1, other: 1 };
    const recTierIndex = Math.min(tierIndexMap[projectType] ?? 1, serverCosts.length - 1);
    const recTier      = serverCosts[recTierIndex];

    res.status(200).json({
      success: true,
      message: 'Cost estimate generated successfully',
      data: {
        summary: {
          projectName,
          currency,
          projectType,
          complexityLevel,
          complexityDescription: profile.description,
          totalProjectCost: total,
          estimatedTimeline: {
            min:  profile.timeline.min,
            max:  profile.timeline.max,
            unit: 'months',
            note: `Typical timeline for a ${complexityLevel} ${projectType}: ${profile.timeline.min}–${profile.timeline.max} months`,
          },
          annualMaintenanceRate:   maintenancePlans.annualRate,
          baseMonthlyMaintenance:  maintenancePlans.baseMonthlyAverage,
          recommendedServerTier:   recTier.tier,
          recommendedMonthlyServer: recTier.monthly,
        },

        projectBreakdown,

        maintenancePlans,

        serverCosts: {
          note: `All amounts in ${currency} (INR). Server costs are estimated ranges — actual billing depends on usage.`,
          tiers: serverCosts,
        },

        totalCostOfOwnership: {
          note: `TCO = one-time project cost + cumulative maintenance + cumulative server cost (range).`,
          ...tco,
        },

        // At-a-glance comparison table across all server tiers for quick client sharing
        comparisonTable: (() => {
          const horizons = ['1year', '3year', '5year'];
          return serverCosts.map((t) => {
            const row = { serverTier: t.tier, monthlyServer: t.monthly };
            for (const h of horizons) {
              const serverKey = h === '1year' ? 'yearly' : h;
              const maint = maintenancePlans.plans[h].totalCost;
              row[h] = {
                maintenance: maint,
                server: t[serverKey],
                totalMin: total + maint + t[serverKey].min,
                totalMax: total + maint + t[serverKey].max,
              };
            }
            return row;
          });
        })(),

        // Three ready-to-present proposal scenarios
        proposalScenarios: [
          {
            label:       'Budget',
            description: 'Minimal ongoing investment — suitable for early-stage or low-traffic projects.',
            serverTier:  serverCosts[0].tier,
            monthlyCost: {
              maintenance: maintenancePlans.baseMonthlyAverage,
              server:      serverCosts[0].monthly.min,
              total:       maintenancePlans.baseMonthlyAverage + serverCosts[0].monthly.min,
            },
            '3year': { min: total + maintenancePlans.plans['3year'].totalCost + serverCosts[0]['3year'].min, max: total + maintenancePlans.plans['3year'].totalCost + serverCosts[0]['3year'].max },
            '5year': { min: total + maintenancePlans.plans['5year'].totalCost + serverCosts[0]['5year'].min, max: total + maintenancePlans.plans['5year'].totalCost + serverCosts[0]['5year'].max },
          },
          {
            label:       'Recommended',
            description: 'Best balance of performance, reliability and cost — ideal for most production projects.',
            serverTier:  recTier.tier,
            monthlyCost: {
              maintenance: maintenancePlans.baseMonthlyAverage,
              server:      round((recTier.monthly.min + recTier.monthly.max) / 2),
              total:       maintenancePlans.baseMonthlyAverage + round((recTier.monthly.min + recTier.monthly.max) / 2),
            },
            '3year': { min: total + maintenancePlans.plans['3year'].totalCost + recTier['3year'].min, max: total + maintenancePlans.plans['3year'].totalCost + recTier['3year'].max },
            '5year': { min: total + maintenancePlans.plans['5year'].totalCost + recTier['5year'].min, max: total + maintenancePlans.plans['5year'].totalCost + recTier['5year'].max },
          },
          {
            label:       'Enterprise',
            description: 'Auto-scaling cloud infrastructure with high availability, CDN and managed services.',
            serverTier:  serverCosts[2].tier,
            monthlyCost: {
              maintenance: maintenancePlans.baseMonthlyAverage,
              server:      serverCosts[2].monthly.min,
              total:       maintenancePlans.baseMonthlyAverage + serverCosts[2].monthly.min,
            },
            '3year': { min: total + maintenancePlans.plans['3year'].totalCost + serverCosts[2]['3year'].min, max: total + maintenancePlans.plans['3year'].totalCost + serverCosts[2]['3year'].max },
            '5year': { min: total + maintenancePlans.plans['5year'].totalCost + serverCosts[2]['5year'].min, max: total + maintenancePlans.plans['5year'].totalCost + serverCosts[2]['5year'].max },
          },
        ],
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/calculator/profiles
 * Returns all available project type / complexity combinations so the frontend
 * can build dynamic dropdowns without hardcoding.
 */
router.get('/profiles', (_req, res) => {
  const profiles = {};
  for (const [type, complexities] of Object.entries(PROFILES)) {
    profiles[type] = {};
    for (const [level, p] of Object.entries(complexities)) {
      profiles[type][level] = {
        description:     p.description,
        maintenanceRate: `${round(p.maintenanceRate * 100)}%`,
        timeline:        p.timeline,
        breakdown:       Object.fromEntries(
          Object.entries(p.ratios).map(([k, v]) => [k, `${round(v * 100)}%`])
        ),
      };
    }
  }
  res.status(200).json({
    success: true,
    message: 'Available profiles',
    data: {
      projectTypes:    Object.keys(PROFILES),
      complexityLevels: ['basic', 'standard', 'advanced', 'enterprise'],
      profiles,
      serverTiers:     SERVER_TIERS.map(({ tier, suitableFor, monthly, specs, bestFor }) => ({
        tier, suitableFor, monthly, specs, bestFor,
      })),
    },
  });
});

export default router;
