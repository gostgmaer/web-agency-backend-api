import express from "express";
import { authenticate } from "../middleware/auth.js";
import { validateRequest, sanitizeInput } from "../middleware/validation.js";
import { createInquiryValidation, inquiryIdValidation } from "../validation/inquiryValidation.js";
import { getPaginationParams, getPaginationMeta } from "../utils/pagination.js";
import { sendInquiryNotification, sendInquiryConfirmation } from "../utils/email.js";
import Inquiry from "../models/Inquiry.js";
import logger from "../utils/logger.js";
import { NotFoundError, BadRequestError } from "../utils/errors.js";
import {generateProposal} from "../services/generateProposal.js";
const router = express.Router();

/**
 * @swagger
 * /api/inquiry:
 *   post:
 *     summary: Submit project inquiry
 *     tags: [Inquiry]
 *     responses:
 *       201:
 *         description: Inquiry created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     priority:
 *                       type: string
 *                     inquiryNumber:
 *                       type: integer
 */
router.post("/", createInquiryValidation, validateRequest, sanitizeInput, async (req, res, next) => {
	try {
		const inquiryData = {
			...req.body,
			ipAddress: req.ip,
			userAgent: req.get("User-Agent"),
			referrer: req.get("Referer"),
		};

		const inquiry = new Inquiry(inquiryData);
		await inquiry.save();

		// Send email notifications (non-blocking)
		Promise.all([sendInquiryNotification(inquiry), sendInquiryConfirmation(inquiry)]).catch((emailError) => {
			logger.error("Failed to send inquiry emails:", { error: emailError.message, inquiryId: inquiry._id });
		});

		// generateProposal({
		// 	templateType: "smallStaticproposal",
		// 	count: inquiry.inquiryNumber,
		// 	variables: {
		// 		client: inquiry.name,
		// 		company: inquiry.company,
		// 		development_cost: "₹45,000",
		// 		gst_amount: "₹8,100",
		// 		total_amount: "₹53,100",
		// 	},
		// })
		// 	.then((res) => {
		// 		console.log("Proposal Generated:", res);
		// 	})
		// 	.catch((err) => {
		// 		console.error(err);
		// 	});

		logger.info("Inquiry submitted", {
			inquiryId: inquiry._id,
			email: inquiry.email,
			projectType: inquiry.projectType,
			budget: inquiry.budget,
			priority: inquiry.priority,
		});

		res
			.status(201)
			.json({
				success: true,
				message: "Thank you for your inquiry. We will review your project and get back to you soon",
				data: { id: inquiry._id, priority: inquiry.priority, inquiryNumber: inquiry.inquiryNumber },
			});
	} catch (error) {
		next(error);
	}
});

/**
 * @swagger
 * /api/inquiry:
 *   get:
 *     summary: Get all inquiries (Admin only)
 *     tags: [Inquiry]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of inquiries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     inquiries:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           inquiryNumber:
 *                             type: integer
 */
router.get("/", authenticate, async (req, res, next) => {
	try {
		const { page, limit, skip } = getPaginationParams(req);
		const { status, priority, projectType, assignedTo, search } = req.query;

		let filter = { isDeleted: false };
		if (status) filter.status = status;
		if (priority) filter.priority = priority;
		if (projectType) filter.projectType = projectType;
		if (assignedTo) filter.assignedTo = assignedTo;

		if (search) {
			filter.$or = [
				{ name: { $regex: search, $options: "i" } },
				{ email: { $regex: search, $options: "i" } },
				{ company: { $regex: search, $options: "i" } },
			];
		}

		const total = await Inquiry.countDocuments(filter);
		const inquiries = await Inquiry.find(filter)
			.populate("assignedTo", "name email")
			.select("-notes -statusHistory")
			.sort({ createdAt: -1 })
			.skip(skip)
			.limit(limit);

		const pagination = getPaginationMeta(total, page, limit);

		res.json({ success: true, message: "Inquiries retrieved successfully", data: { inquiries, pagination } });
	} catch (error) {
		next(error);
	}
});

/**
 * @swagger
 * /api/inquiry/stats:
 *   get:
 *     summary: Get inquiry statistics (Admin only)
 *     tags: [Inquiry]
 *     security:
 *       - bearerAuth: []
 */
router.get("/stats", authenticate, async (req, res, next) => {
	try {
		const statusCounts = await Inquiry.countByStatus();
		const total = await Inquiry.countDocuments({ isDeleted: false });
		const todayCount = await Inquiry.countDocuments({
			isDeleted: false,
			createdAt: { $gte: new Date().setHours(0, 0, 0, 0) },
		});

		// Inquiries due for follow-up
		const followUpDue = await Inquiry.countDocuments({
			isDeleted: false,
			nextFollowUp: { $lte: new Date() },
			status: { $nin: ["completed", "cancelled", "rejected"] },
		});

		// By project type
		const byProjectType = await Inquiry.aggregate([
			{ $match: { isDeleted: false } },
			{ $group: { _id: "$projectType", count: { $sum: 1 } } },
		]);

		res.json({
			success: true,
			message: "Inquiry statistics retrieved",
			data: {
				total,
				today: todayCount,
				followUpDue,
				byStatus: statusCounts.reduce((acc, curr) => {
					acc[curr._id] = curr.count;
					return acc;
				}, {}),
				byProjectType: byProjectType.reduce((acc, curr) => {
					acc[curr._id] = curr.count;
					return acc;
				}, {}),
			},
		});
	} catch (error) {
		next(error);
	}
});

/**
 * @swagger
 * /api/inquiry/follow-up:
 *   get:
 *     summary: Get inquiries due for follow-up (Admin only)
 *     tags: [Inquiry]
 *     security:
 *       - bearerAuth: []
 */
router.get("/follow-up", authenticate, async (req, res, next) => {
	try {
		const inquiries = await Inquiry.findDueForFollowUp()
			.populate("assignedTo", "name email")
			.select("name email company projectType budget status priority nextFollowUp")
			.sort({ nextFollowUp: 1 });

		res.json({ success: true, message: "Follow-up inquiries retrieved", data: { inquiries } });
	} catch (error) {
		next(error);
	}
});

/**
 * @swagger
 * /api/inquiry/{id}:
 *   get:
 *     summary: Get inquiry by ID (Admin only)
 *     tags: [Inquiry]
 *     security:
 *       - bearerAuth: []
 */
router.get("/:id", authenticate, inquiryIdValidation, validateRequest, async (req, res, next) => {
	try {
		const inquiry = await Inquiry.findOne({ _id: req.params.id, isDeleted: false })
			.populate("assignedTo", "name email")
			.populate("quotedBy", "name email")
			.populate("notes.createdBy", "name email")
			.populate("statusHistory.changedBy", "name email");

		if (!inquiry) {
			throw new NotFoundError("Inquiry");
		}

		res.json({ success: true, message: "Inquiry retrieved successfully", data: { inquiry } });
	} catch (error) {
		next(error);
	}
});

/**
 * @swagger
 * /api/inquiry/{id}/status:
 *   patch:
 *     summary: Update inquiry status (Admin only)
 *     tags: [Inquiry]
 *     security:
 *       - bearerAuth: []
 */
router.patch("/:id/status", authenticate, inquiryIdValidation, validateRequest, async (req, res, next) => {
	try {
		const { status, note } = req.body;
		const validStatuses = [
			"new",
			"reviewing",
			"contacted",
			"quoted",
			"negotiating",
			"accepted",
			"rejected",
			"completed",
			"cancelled",
		];

		if (!status || !validStatuses.includes(status)) {
			throw new BadRequestError("Invalid status value");
		}

		const inquiry = await Inquiry.findOne({ _id: req.params.id, isDeleted: false });

		if (!inquiry) {
			throw new NotFoundError("Inquiry");
		}

		await inquiry.changeStatus(status, req.admin._id, note);

		logger.info("Inquiry status updated", { inquiryId: inquiry._id, status, updatedBy: req.admin.email });

		res.json({ success: true, message: "Inquiry status updated successfully", data: { inquiry } });
	} catch (error) {
		next(error);
	}
});

/**
 * @swagger
 * /api/inquiry/{id}/assign:
 *   patch:
 *     summary: Assign inquiry to admin (Admin only)
 *     tags: [Inquiry]
 *     security:
 *       - bearerAuth: []
 */
router.patch("/:id/assign", authenticate, inquiryIdValidation, validateRequest, async (req, res, next) => {
	try {
		const { assignTo } = req.body;

		if (!assignTo) {
			throw new BadRequestError("assignTo is required");
		}

		const inquiry = await Inquiry.findOne({ _id: req.params.id, isDeleted: false });

		if (!inquiry) {
			throw new NotFoundError("Inquiry");
		}

		await inquiry.assignTo(assignTo, req.admin._id);
		await inquiry.populate("assignedTo", "name email");

		logger.info("Inquiry assigned", { inquiryId: inquiry._id, assignedTo: assignTo, assignedBy: req.admin.email });

		res.json({ success: true, message: "Inquiry assigned successfully", data: { inquiry } });
	} catch (error) {
		next(error);
	}
});

/**
 * @swagger
 * /api/inquiry/{id}/quote:
 *   patch:
 *     summary: Set quote for inquiry (Admin only)
 *     tags: [Inquiry]
 *     security:
 *       - bearerAuth: []
 */
router.patch("/:id/quote", authenticate, inquiryIdValidation, validateRequest, async (req, res, next) => {
	try {
		const { amount, currency = "USD" } = req.body;

		if (!amount || amount <= 0) {
			throw new BadRequestError("Valid quote amount is required");
		}

		const inquiry = await Inquiry.findOne({ _id: req.params.id, isDeleted: false });

		if (!inquiry) {
			throw new NotFoundError("Inquiry");
		}

		await inquiry.setQuote(amount, currency, req.admin._id);

		logger.info("Quote set for inquiry", { inquiryId: inquiry._id, amount, currency, quotedBy: req.admin.email });

		res.json({ success: true, message: "Quote set successfully", data: { inquiry } });
	} catch (error) {
		next(error);
	}
});

/**
 * @swagger
 * /api/inquiry/{id}/note:
 *   post:
 *     summary: Add note to inquiry (Admin only)
 *     tags: [Inquiry]
 *     security:
 *       - bearerAuth: []
 */
router.post("/:id/note", authenticate, inquiryIdValidation, validateRequest, async (req, res, next) => {
	try {
		const { content, isInternal = true } = req.body;

		if (!content || content.trim().length === 0) {
			throw new BadRequestError("Note content is required");
		}

		const inquiry = await Inquiry.findOne({ _id: req.params.id, isDeleted: false });

		if (!inquiry) {
			throw new NotFoundError("Inquiry");
		}

		await inquiry.addNote(content, req.admin._id, isInternal);
		await inquiry.populate("notes.createdBy", "name email");

		logger.info("Note added to inquiry", { inquiryId: inquiry._id, addedBy: req.admin.email });

		res.json({ success: true, message: "Note added successfully", data: { inquiry } });
	} catch (error) {
		next(error);
	}
});

/**
 * @swagger
 * /api/inquiry/{id}/follow-up:
 *   patch:
 *     summary: Set follow-up date (Admin only)
 *     tags: [Inquiry]
 *     security:
 *       - bearerAuth: []
 */
router.patch("/:id/follow-up", authenticate, inquiryIdValidation, validateRequest, async (req, res, next) => {
	try {
		const { date } = req.body;

		if (!date) {
			throw new BadRequestError("Follow-up date is required");
		}

		const followUpDate = new Date(date);
		if (isNaN(followUpDate.getTime())) {
			throw new BadRequestError("Invalid date format");
		}

		const inquiry = await Inquiry.findOneAndUpdate(
			{ _id: req.params.id, isDeleted: false },
			{ nextFollowUp: followUpDate },
			{ new: true },
		);

		if (!inquiry) {
			throw new NotFoundError("Inquiry");
		}

		logger.info("Follow-up date set", { inquiryId: inquiry._id, followUpDate, setBy: req.admin.email });

		res.json({ success: true, message: "Follow-up date set successfully", data: { inquiry } });
	} catch (error) {
		next(error);
	}
});

/**
 * @swagger
 * /api/inquiry/{id}:
 *   delete:
 *     summary: Delete inquiry (Admin only) - Soft delete
 *     tags: [Inquiry]
 *     security:
 *       - bearerAuth: []
 */
router.delete("/:id", authenticate, inquiryIdValidation, validateRequest, async (req, res, next) => {
	try {
		const inquiry = await Inquiry.findOne({ _id: req.params.id, isDeleted: false });

		if (!inquiry) {
			throw new NotFoundError("Inquiry");
		}

		await inquiry.softDelete();

		logger.info("Inquiry deleted", { inquiryId: inquiry._id, deletedBy: req.admin.email });

		res.json({ success: true, message: "Inquiry deleted successfully", data: {} });
	} catch (error) {
		next(error);
	}
});

export default router;
