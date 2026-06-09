import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import logger from "./logger.js";

const s3Configured =
	process.env.AWS_ACCESS_KEY_ID &&
	process.env.AWS_SECRET_ACCESS_KEY &&
	process.env.AWS_S3_BUCKET &&
	process.env.AWS_REGION;

let s3Client = null;
if (s3Configured) {
	s3Client = new S3Client({
		region: process.env.AWS_REGION,
		credentials: {
			accessKeyId: process.env.AWS_ACCESS_KEY_ID,
			secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
		},
	});
	logger.info("Stateless Gateway Storage: S3 upload client initialized.");
} else {
	logger.warn("Stateless Gateway Storage: AWS S3 credentials missing. Falling back to local filesystem.");
}

/**
 * Uploads a buffer to S3 or writes to local filesystem fallback.
 * @param {Buffer} buffer 
 * @param {string} fileName 
 * @param {string} mimeType 
 * @param {object} req 
 * @returns {Promise<string>} publicUrl
 */
export async function uploadFile(buffer, fileName, mimeType, req) {
	if (s3Configured && s3Client) {
		const bucketName = process.env.AWS_S3_BUCKET;
		const key = `proposals/${fileName}`;
		
		await s3Client.send(
			new PutObjectCommand({
				Bucket: bucketName,
				Key: key,
				Body: buffer,
				ContentType: mimeType,
			})
		);
		
		const customDomain = process.env.AWS_S3_CUSTOM_DOMAIN;
		if (customDomain) {
			return `${customDomain}/${key}`;
		}
		return `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
	}

	// Local filesystem fallback
	const uploadsDir = path.resolve(process.cwd(), "uploads", "proposals");
	const outputPath = path.join(uploadsDir, fileName);

	if (!fs.existsSync(uploadsDir)) {
		fs.mkdirSync(uploadsDir, { recursive: true });
	}

	fs.writeFileSync(outputPath, buffer);

	const protocol = req.protocol || "http";
	const host = req.get("host");
	return `${protocol}://${host}/uploads/proposals/${fileName}`;
}
