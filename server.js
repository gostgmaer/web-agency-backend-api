import dotenv from "dotenv";
import app from "./app.js";
import { connectDatabase } from "./config/database.js";
import logger from "./utils/logger.js";

dotenv.config();

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    await connectDatabase();

    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`API Docs: http://localhost:${PORT}/api-docs`);
    });
  } catch (error) {
    logger.error("Failed to start server", error);
    process.exit(1);
  }
};

startServer();
