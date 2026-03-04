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
		secret: process.env.JWT_SECRET,
		expire: process.env.JWT_EXPIRE || "7d",
		refreshSecret: process.env.JWT_REFRESH_SECRET,
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

	admin: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },

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
