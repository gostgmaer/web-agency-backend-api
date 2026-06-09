import express from "express";
import { authenticate } from "../middleware/auth.js";
import { BadRequestError } from "../utils/errors.js";
import { uploadFile } from "../utils/storage.js";

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

		const normalizedBase64 =
			String(contentBase64).includes(",") ? String(contentBase64).split(",")[1] : String(contentBase64);

		// VALIDATION FIX: Wrap base64 decoding in try-catch to return 400 instead of 500
		// Invalid base64 string would crash Buffer.from and return server error
		let buffer;
		try {
			buffer = Buffer.from(normalizedBase64, "base64");
			if (buffer.length === 0) {
				throw new BadRequestError("Invalid base64 content: decoding resulted in empty buffer");
			}
		} catch (decodeErr) {
			throw new BadRequestError(
				`Invalid base64 encoding: ${decodeErr instanceof Error ? decodeErr.message : 'unknown error'}`
			);
		}

		const publicUrl = await uploadFile(buffer, normalizedFileName, mimeType, req);

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
