import dotenv from "dotenv";

dotenv.config();

function resolveServiceOrigin(rawUrl, fallback = "") {
	const candidate = String(rawUrl || fallback || "").trim();
	if (!candidate) return "";

	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)
		? candidate
		: `http://${candidate}`;

	try {
		const parsed = new URL(withScheme);
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return "";
	}
}

const authServiceOrigin = resolveServiceOrigin(process.env.AUTH_SERVICE_URL);
const defaultIamServiceOrigin = resolveServiceOrigin(process.env.AUTH_SERVICE_URL, "http://localhost:4002");

const isServerless = Boolean(
	process.env.VERCEL ||
	process.env.AWS_LAMBDA_FUNCTION_NAME ||
	process.env.NETLIFY ||
	process.env.SERVERLESS ||
	process.env.DISABLE_FILE_LOGGING === "true",
);

export const config = {
	app: {
		nodeEnv: process.env.NODE_ENV || "development",
		port: process.env.PORT || 3500,
		frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
		corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(",") : ["http://localhost:3000"],
		version: process.env.NPM_PACKAGE_VERSION || "1.0.0",
		isServerless,
	},

	database: { mongoUri: process.env.MONGODB_URI },

	jwt: {
		// Must match JWT_ACCESS_SECRET in the user-auth-service
		accessSecret: process.env.JWT_ACCESS_SECRET,
		issuer: process.env.JWT_ISSUER || 'user-auth-service',
		audience: process.env.JWT_AUDIENCE || 'dashboard-app',
	},

	email: {
		serviceUrl: process.env.EMAIL_SERVICE_URL,
		fromEmail: process.env.FROM_EMAIL,
		fromName: process.env.FROM_NAME,
		adminEmail: process.env.ADMIN_EMAIL,
	},

	admin: { email: process.env.ADMIN_EMAIL },

	// External microservice base URLs
	fileUpload: { serviceUrl: process.env.FILE_UPLOAD_SERVICE_URL },
	auth: { serviceUrl: authServiceOrigin },

	// ─── IAM Service ─────────────────────────────────────────────────────────
	// Same service as config.auth — AUTH_SERVICE_URL is the single source of truth.
	// iam.serviceUrl is used for SSO token generation calls.
	// No per-product APP_ID env vars — the key in config.products IS the IAM slug.
	iam: {
		serviceUrl: defaultIamServiceOrigin,
		adminEmail: process.env.IAM_ADMIN_EMAIL || '',
		adminPassword: process.env.IAM_ADMIN_PASSWORD || '',
		adminJwt: process.env.IAM_ADMIN_JWT || '',
	},

	// ─── AI Communication Service ─────────────────────────────────────────────
	// Full versioned API URL, e.g. http://localhost:4001/api/v1
	// Parsed here so nothing downstream needs to know the version prefix.
	communication: (() => {
		const raw = process.env.COMMUNICATION_URL || 'http://localhost:4001/api/v1';
		const parsed = new URL(raw);
		return {
			proxyTarget: `${parsed.protocol}//${parsed.host}`,     // host only  — proxy target
			proxyPath:   parsed.pathname.replace(/\/$/, ''),       // /api/v1    — proxy path prefix
		};
	})(),

	// ─── Notification Service ─────────────────────────────────────────────────
	notification: {
		healthUrl: process.env.NOTIFICATION_SERVICE_HEALTH_URL || 'https://notification-service-iota.vercel.app/v1/health/detailed',
	},

	// Tenant ID — used as a fallback x-tenant-id for all proxied requests.
	// Required for single-tenant deployments; in multi-tenant mode, each
	// client passes its own x-tenant-id header and this is not used.
	tenantId: process.env.TENANT_ID || null,

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
		serviceUrl: process.env.PAYMENT_SERVICE_URL || 'http://localhost:3000',
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
	//   "easydev-communication" — calls POST /onboarding/create-account on the
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
	// checkout request as { productId: "easydev-communication" } and matched here.
	products: {
		// EasyDev AI Communication Platform
		'easydev-communication': {
			name:          'EasyDev Communication AI',
			description:   'AI-powered WhatsApp & email automation platform',
			provisionType: 'easydev-communication',
			provisionUrl:  process.env.COMMUNICATION_URL || 'http://localhost:4001/api/v1',
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
				applicationSlug: process.env.COMMUNICATION_IAM_APPLICATION_SLUG || 'easydev-ai-communication',
				tenantSlug: process.env.COMMUNICATION_IAM_TENANT_SLUG || process.env.IAM_TENANT_SLUG || 'easydev',
				defaultRole: process.env.COMMUNICATION_IAM_DEFAULT_ROLE || 'member',
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
		// Add future products here, e.g.:
		// 'easydev-analytics': {
		//   name: 'EasyDev Analytics',
		//   provisionType: 'generic-webhook',
		//   apiUrl: process.env.ANALYTICS_API_URL,
		//   apiKey: process.env.ANALYTICS_API_KEY,
		//   iamProvisioning: {
		//     provider: 'shared-iam',
		//     applicationSlug: process.env.ANALYTICS_IAM_APPLICATION_SLUG,
		//     tenantSlug: process.env.ANALYTICS_IAM_TENANT_SLUG || process.env.IAM_TENANT_SLUG,
		//     defaultRole: process.env.ANALYTICS_IAM_DEFAULT_ROLE || 'member',
		//     bootstrapUser: true,
		//     requirePasswordChangeOnFirstLogin: true,
		//   },
		// },
	},

	logging: {
		enabled: process.env.ENABLE_LOGGING !== "false",
		level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
	},

	performance: {
		clusterMode: process.env.CLUSTER_MODE === "true",
		requestTimeout: Number(process.env.REQUEST_TIMEOUT) || 30000,
		shutdownTimeout: Number(process.env.SHUTDOWN_TIMEOUT) || 10000,
	},

	docs: { enableSwagger: process.env.ENABLE_SWAGGER === "true" },

	// ─── Dashboard URL (used in lead email links) ─────────────────────────────
	dashboard: { url: process.env.DASHBOARD_URL || 'http://localhost:3000' },

	// ─── Lead Email API Key (sent to email microservice) ─────────────────────
	emailApiKey: process.env.EMAIL_SERVICE_API_KEY || '',

	// ─── Tenancy (multi-tenant lead scoping) ─────────────────────────────────
	tenant: {
		enabled: process.env.TENANCY_ENABLED !== 'false',
		defaultTenantId: process.env.DEFAULT_TENANT_ID || process.env.TENANT_ID || 'easydev',
	},

	// ─── Redis (optional — lead rate-limiter and scheduler lock) ─────────────
	redis: {
		enabled: process.env.REDIS_ENABLED === 'true',
		url: process.env.REDIS_URL || 'redis://localhost:6379',
	},
};
