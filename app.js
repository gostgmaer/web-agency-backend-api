import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mongoSanitize from "express-mongo-sanitize";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import dotenv from "dotenv";

// Middleware
import { errorHandler, notFound } from "./middleware/errorHandler.js";
// import { requestLogger } from "./middleware/requestLogger.js";

// Routes
import authRoutes from "./routes/auth.js";
import newsletterRoutes from "./routes/newsletter.js";
import blogRoutes from "./routes/blog.js";
import contactRoutes from "./routes/contact.js";
import inquiryRoutes from "./routes/inquiry.js";
import planRoutes from "./routes/plans.js";

dotenv.config();

const app = express();

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    success: false,
    message: "Too many requests from this IP, please try again later",
    errors: []
  }
});

// Swagger configuration
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Web Development Agency API",
      version: "1.0.0",
      description: "REST API for Web Development Agency website"
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT"
        }
      }
    }
  },
  apis: ["./routes/*.js"]
};

const specs = swaggerJsdoc(swaggerOptions);

// Global middleware
app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3001",
    credentials: true
  })
);
app.use(limiter);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(mongoSanitize());
// app.use(requestLogger);

// API Docs (enable conditionally if needed)
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/newsletter", newsletterRoutes);
app.use("/api/blogs", blogRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/inquiry", inquiryRoutes);
app.use("/api/plans", planRoutes);

// Health check
app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Server is running successfully",
    data: {
      status: "healthy",
      timestamp: new Date().toISOString()
    }
  });
});

// Error handling
app.use(notFound);
app.use(errorHandler);

export default app;
