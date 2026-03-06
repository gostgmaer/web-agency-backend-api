import express from "express";
import fs from "fs";
import path from "path";
import { authenticate } from "../middleware/auth.js";
import { BadRequestError } from "../utils/errors.js";

const router = express.Router();

function sanitizeFileName(fileName = "proposal.html") {
	return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

router.post("/proposal", authenticate, async (req, res, next) => {
	try {
		const { fileName, mimeType = "text/html", contentBase64 } = req.body;

		if (!contentBase64) {
			throw new BadRequestError("contentBase64 is required");
		}

		const normalizedFileName = sanitizeFileName(fileName || `proposal-${Date.now()}.html`);
		const uploadsDir = path.resolve(process.cwd(), "uploads", "proposals");
		const outputPath = path.join(uploadsDir, normalizedFileName);

		if (!fs.existsSync(uploadsDir)) {
			fs.mkdirSync(uploadsDir, { recursive: true });
		}

		const normalizedBase64 =
			String(contentBase64).includes(",") ? String(contentBase64).split(",")[1] : String(contentBase64);

		const buffer = Buffer.from(normalizedBase64, "base64");
		fs.writeFileSync(outputPath, buffer);

		const protocol = req.protocol || "http";
		const host = req.get("host");
		const publicUrl = `${protocol}://${host}/uploads/proposals/${normalizedFileName}`;

		res
			.status(201)
			.json({
				success: true,
				message: "Proposal file uploaded successfully",
				data: { fileName: normalizedFileName, mimeType, url: publicUrl },
			});
	} catch (error) {
		next(error);
	}
});

export default router;
