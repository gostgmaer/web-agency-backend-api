import dotenv from "dotenv";

dotenv.config();

function resolveServiceOrigin(rawUrl, fallback = "") {
	if (!rawUrl && !fallback) {
		throw new Error("Service URL is required (no fallback allowed)");
	}
	const candidate = String(rawUrl || fallback || "").trim();
	if (!candidate) {
		throw new Error("Service URL cannot be empty");
	}

	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)
		? candidate
		: `http://${candidate}`;

	try {
		const parsed = new URL(withScheme);
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		throw new Error(`Invalid service URL format: ${candidate}`);
	}
}

function getRequiredEnv(name) {
	const value = process.env[name];
	if (!value || !String(value).trim()) {
		throw new Error(`${name} environment variable is required`);
	}
	return String(value).trim();
}

function getFirstDefinedEnv(...names) {
	for (const name of names) {
		const value = process.env[name];
		if (value && String(value).trim()) {
			return String(value).trim();
		}
	}
	return "";
}

const authServiceOrigin = resolveServiceOrigin(process.env.AUTH_SERVICE_URL);
const fileUploadServiceOrigin = resolveServiceOrigin(
	process.env.FILE_UPLOAD_SERVICE_URL,
	"https://file-upload-service-zjtv.onrender.com",
);

const isServerless = Boolean(
	process.env.VERCEL ||
	process.env.AWS_LAMBDA_FUNCTION_NAME ||
	process.env.NETLIFY ||
	process.env.SERVERLESS ||
	process.env.DISABLE_FILE_LOGGING === "true",
);

const configuredTenantRef = getRequiredEnv("TENANT");

export const config = {
	app: {
		nodeEnv: process.env.NODE_ENV || "development",
		name: process.env.APP_NAME || "EasyDev",
		port: process.env.PORT ? parseInt(process.env.PORT, 10) : (() => {
			throw new Error("PORT environment variable is required and must be a valid number");
		})(),
		frontendUrl: process.env.FRONTEND_URL || (() => {
			throw new Error("FRONTEND_URL environment variable is required");
		})(),
		corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(",") : (() => {
			throw new Error("CORS_ORIGINS environment variable is required");
		})(),
		version: process.env.NPM_PACKAGE_VERSION || "1.0.0",
		isServerless,
	},

	database: { mongoUri: process.env.MONGODB_URI },

	jwt: {
		// Canonical key is JWT_SECRET; JWT_ACCESS_SECRET is legacy fallback.
		accessSecret: getFirstDefinedEnv("JWT_SECRET", "JWT_ACCESS_SECRET"),
		issuer: getRequiredEnv('JWT_ISSUER'),
		audience: getRequiredEnv('JWT_AUDIENCE'),
	},

	email: {
		// Notification service is the canonical transactional email backend.
		serviceUrl: getFirstDefinedEnv("NOTIFICATION_SERVICE_URL", "EMAIL_SERVICE_URL"),
		fromEmail: process.env.FROM_EMAIL,
		fromName: process.env.FROM_NAME,
		adminEmail: process.env.ADMIN_EMAIL,
	},

	admin: { email: process.env.ADMIN_EMAIL },

	// External microservice base URLs
	fileUpload: {
		serviceUrl: process.env.FILE_UPLOAD_SERVICE_URL,
		healthUrl:
			process.env.FILE_UPLOAD_SERVICE_HEALTH_URL ||
			(fileUploadServiceOrigin ? `${fileUploadServiceOrigin}/health` : ""),
	},
	auth: { serviceUrl: authServiceOrigin },

	// ─── IAM Service ─────────────────────────────────────────────────────────
	// Same service as config.auth — AUTH_SERVICE_URL is the single source of truth.
	// iam.serviceUrl is used for SSO token generation calls.
	// No per-product APP_ID env vars — the key in config.products IS the IAM slug.
	iam: {
		serviceUrl: authServiceOrigin,
		adminEmail: process.env.IAM_ADMIN_EMAIL || '',
		adminPassword: process.env.IAM_ADMIN_PASSWORD || '',
		adminJwt: process.env.IAM_ADMIN_JWT || '',
	},

	// ─── AI Communication Service ─────────────────────────────────────────────
	// Full versioned API URL, e.g. http://localhost:3303/api/v1
	// Parsed here so nothing downstream needs to know the version prefix.
	communication: (() => {
		const raw = process.env.COMMUNICATION_URL || (() => {
			throw new Error("COMMUNICATION_URL environment variable is required");
		})();
		const parsed = new URL(raw);
		return {
			proxyTarget: `${parsed.protocol}//${parsed.host}`,     // host only  — proxy target
			proxyPath:   parsed.pathname.replace(/\/$/, ''),       // /api/v1    — proxy path prefix
		};
	})(),

	// ─── Notification Service ─────────────────────────────────────────────────
	notification: {
		healthUrl: process.env.NOTIFICATION_SERVICE_HEALTH_URL || 'https://notification-service-iota.vercel.app/v1/health',
	},

	// Canonical tenant reference used by gateway.
	// Set only TENANT (slug/displayId/internalId/publicId) in env.
	tenantRef: configuredTenantRef,

	// ─── Payment Gateways ────────────────────────────────────────────────────
	// Only the Razorpay public key is needed here — returned to the frontend
	// checkout UI. All secrets and webhook handling live in payment-microservice.
	razorpay: {
		keyId: process.env.RAZORPAY_KEY_ID,
	},

	// ─── Payment Microservice ──────────────────────────────────────────────
	// Central payment processing service. web-agency-backend-api delegates all
	// checkout and webhook operations here via service-to-service API key auth.
	payment: {
		serviceUrl: process.env.PAYMENT_SERVICE_URL || (() => {
			throw new Error("PAYMENT_SERVICE_URL environment variable is required");
		})(),
		// API key sent as x-api-key header. Must match API_KEY_HASH on the
		// payment-microservice side (SHA-256 hash of this plaintext key).
		apiKey: process.env.PAYMENT_SERVICE_API_KEY || '',
	},

	// ─── Multi-Product Configuration ─────────────────────────────────────────
	// Each product key maps a product ID to its provisioning details.
	// After a successful payment web-agency-backend-api calls the product's
	// provision URL with the configured API key.
	//
	// Supported provisionType values:
	//   "easydev-ai-communication" — calls POST /onboarding/create-account on the
	//                             AI Communication NestJS backend.
	//
	// Optional per-product iamProvisioning block:
	//   provider                         — 'shared-iam' when the product reuses the central IAM platform
	//   applicationSlug                  — IAM application slug for SSO/app grants
	//   tenantSlug                       — IAM tenant slug for role membership
	//   defaultRole                      — role assigned after purchase
	//   bootstrapUser                    — whether purchased users are marked as bootstrap users
	//   requirePasswordChangeOnFirstLogin — whether the temporary password must be changed on first login
	//
	// Add further products by adding more keys. The product ID is passed in the
	// checkout request as { productId: "easydev-ai-communication" } and matched here.
	products: {
		// EasyDev AI Communication Platform
		'easydev-ai-communication': {
			name:          'EasyDev Communication AI',
			description:   'AI-powered WhatsApp & email automation platform',
			provisionType: 'easydev-ai-communication',
			provisionUrl:  process.env.COMMUNICATION_URL || (() => {
				throw new Error("COMMUNICATION_URL environment variable is required");
			})(),
			apiKey:        process.env.COMMUNICATION_API_KEY,
			features: [
				'AI-powered auto-replies',
				'WhatsApp & email channels',
				'Lead capture & CRM sync',
				'Analytics dashboard',
				'Priority support',
			],
			iamProvisioning: {
				provider: 'shared-iam',
				// Source of truth: product config key, not env.
				applicationSlug: 'easydev-ai-communication',
				tenantSlug: configuredTenantRef,
				defaultRole: 'member',
				bootstrapUser: true,
				requirePasswordChangeOnFirstLogin: true,
			},
			// EasyDev plan key → Communication platform plan enum
			planMap: {
				starter:         'starter',
				growth:          'growth',
				payg:            'payg',
				'pay-as-you-go': 'payg',
				business:        'payg',
				free:            'starter',
				pro:             'growth',
				enterprise:      'payg',
			},
		},
		// ─── EasyDev AI Job Agent ───────────────────────────────────────────────
		'easydev-job-agent': {
			name:          'EasyDev AI Job Agent',
			description:   'Automated job search, matching, and application platform',
			provisionType: 'easydev-job-agent',
			provisionUrl:  process.env.JOB_AGENT_URL || '',
			apiKey:        process.env.JOB_AGENT_API_KEY || '',
			features: [
				'AI-powered job matching',
				'Automated resume analysis (ATS score)',
				'Auto-apply to qualified jobs',
				'Company trust verification',
				'Recruiter outreach (Premium)',
				'Application pipeline CRM',
			],
			iamProvisioning: {
				provider: 'shared-iam',
				applicationSlug: 'easydev-job-agent',
				tenantSlug: configuredTenantRef,
				defaultRole: 'member',
				bootstrapUser: true,
				requirePasswordChangeOnFirstLogin: false,
			},
			planMap: {
				free:       'FREE',
				starter:    'FREE',
				premium:    'PREMIUM',
				growth:     'PREMIUM',
				pro:        'PREMIUM',
				enterprise: 'PREMIUM',
			},
		},
	},

	logging: {
		enabled: process.env.ENABLE_LOGGING !== "false",
		level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
	},

	performance: {
		maxPoolSize: parseInt(process.env.DB_MAX_POOL_SIZE || '20', 10),
		minPoolSize: parseInt(process.env.DB_MIN_POOL_SIZE || '5', 10),
		clusterMode: process.env.CLUSTER_MODE === "true",
		requestTimeout: Number(process.env.REQUEST_TIMEOUT) || 30000,
		shutdownTimeout: Number(process.env.SHUTDOWN_TIMEOUT) || 10000,
	},

	features: {
		enableKafka: process.env.ENABLE_KAFKA === "true",
	},

	docs: { enableSwagger: process.env.ENABLE_SWAGGER === "true" },

	// ─── Dashboard URL (used in lead email links) ─────────────────────────────
	dashboard: { url: process.env.DASHBOARD_URL || (() => {
		throw new Error("DASHBOARD_URL environment variable is required");
	})() },

	// ─── Notification API Key (transactional mail gateway) ───────────────────
	emailApiKey:
		getFirstDefinedEnv("NOTIFICATION_SERVICE_API_KEY", "EMAIL_SERVICE_API_KEY") || '',

	// ─── Tenancy (multi-tenant lead scoping) ─────────────────────────────────
	tenant: {
		enabled: process.env.TENANCY_ENABLED !== 'false',
		isolation: process.env.TENANT_ISOLATION_MODE || 'strict',
		defaultTenantId: configuredTenantRef,
	},

	// ─── Redis (optional — lead rate-limiter and scheduler lock) ─────────────
	redis: {
		enabled: process.env.REDIS_ENABLED === 'true',
		host: process.env.REDIS_HOST || 'localhost',
		port: parseInt(process.env.REDIS_PORT || '6379', 10),
		password: process.env.REDIS_PASSWORD || undefined,
		db: parseInt(process.env.REDIS_DB || '0', 10),
		ssl: process.env.REDIS_SSL === 'true',
		url: process.env.REDIS_URL || (() => {
			throw new Error("REDIS_URL environment variable is required");
		})(),
	},
};
