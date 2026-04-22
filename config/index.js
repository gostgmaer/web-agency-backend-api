import dotenv from "dotenv";

dotenv.config();

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
	auth: { serviceUrl: process.env.AUTH_SERVICE_URL },

	// Tenant ID — used as a fallback x-tenant-id for all proxied requests.
	// Required for single-tenant deployments; in multi-tenant mode, each
	// client passes its own x-tenant-id header and this is not used.
	tenantId: process.env.TENANT_ID || null,

	// ─── Payment Gateways ────────────────────────────────────────────────────
	razorpay: {
		keyId:     process.env.RAZORPAY_KEY_ID,
		keySecret: process.env.RAZORPAY_KEY_SECRET,
		webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
	},
	stripe: {
		secretKey:     process.env.STRIPE_SECRET_KEY,
		webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
		publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
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
	// Add further products by adding more keys. The product ID is passed in the
	// checkout request as { productId: "easydev-communication" } and matched here.
	products: {
		// EasyDev AI Communication Platform
		'easydev-communication': {
			name:          'EasyDev Communication AI',
			provisionType: 'easydev-communication',
			apiUrl:        process.env.COMMUNICATION_API_URL || 'http://localhost:3001/api/v1',
			apiKey:        process.env.COMMUNICATION_API_KEY,
			// EasyDev plan key → Communication platform plan enum
			planMap: {
				starter:  'pro',
				growth:   'pro',
				business: 'enterprise',
				free:     'free',
			},
		},
		// Add future products here, e.g.:
		// 'easydev-analytics': {
		//   name: 'EasyDev Analytics',
		//   provisionType: 'generic-webhook',
		//   apiUrl: process.env.ANALYTICS_API_URL,
		//   apiKey: process.env.ANALYTICS_API_KEY,
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
		defaultTenantId: process.env.DEFAULT_TENANT_ID || 'easydev',
	},

	// ─── Redis (optional — lead rate-limiter and scheduler lock) ─────────────
	redis: {
		enabled: process.env.REDIS_ENABLED === 'true',
		url: process.env.REDIS_URL || 'redis://localhost:6379',
	},
};
