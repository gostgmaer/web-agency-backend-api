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
		smtp: {
			host: process.env.SMTP_HOST,
			port: Number(process.env.SMTP_PORT) || 587,
			user: process.env.SMTP_USER,
			pass: process.env.SMTP_PASS,
		},
		fromEmail: process.env.FROM_EMAIL,
		fromName: process.env.FROM_NAME,
		adminEmail: process.env.ADMIN_EMAIL,
	},

	admin: { email: process.env.ADMIN_EMAIL },

	// External microservice base URLs
	lead: { serviceUrl: process.env.LEAD_SERVICE_URL },
	fileUpload: { serviceUrl: process.env.FILE_UPLOAD_SERVICE_URL },
	auth: { serviceUrl: process.env.AUTH_SERVICE_URL },

	// Tenant ID — used as a fallback x-tenant-id for all proxied requests.
	// Required for single-tenant deployments; in multi-tenant mode, each
	// client passes its own x-tenant-id header and this is not used.
	tenantId: process.env.TENANT_ID || null,

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
};
