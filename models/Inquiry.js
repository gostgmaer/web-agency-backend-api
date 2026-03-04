import mongoose from 'mongoose';

// A simple counter collection used for auto-incrementing sequences
const counterSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 }
});

// we create the model here so it can be reused by other modules if needed
const Counter = mongoose.model('Counter', counterSchema);

export const SERVICE_OPTIONS = [
	{ key: "custom_website", label: "Custom Website & Web App Development" },
	{ key: "backend_api", label: "Scalable Backend Development & API Integration" },
	{ key: "admin_dashboard", label: "Admin Dashboard & Internal Tools" },
	{ key: "bug_fixing", label: "Bug Fixing, Optimization & Performance Enhancements" },
	{ key: "payment_integration", label: "Payment Gateway Setup & Integration" },
	{ key: "third_party_integration", label: "Third-Party API & Plugin Integrations" },
	{ key: "auth_setup", label: "Secure Authentication & User Management" },
	{ key: "realtime_features", label: "Real-Time Features (Chat, Notifications, Live Updates)" },
	{ key: "seo_friendly", label: "SEO-Optimized Web Development" },
	{ key: "consultation", label: "Product Strategy & Technical Consultation" },
	{ key: "maintenance", label: "Ongoing Maintenance & Support" },
];

export const BUDGET_RANGES = [
	{ key: "under_50k", label: "Under ₹50,000" },
	{ key: "50k_150k", label: "₹50,000 – ₹1,50,000" },
	{ key: "150k_500k", label: "₹1,50,000 – ₹5,00,000" },
	{ key: "500k_1500k", label: "₹5,00,000 – ₹15,00,000" },
	{ key: "1500k_plus", label: "₹15,00,000+" },
	{ key: "discuss", label: "Let's Discuss" },
];
export const TIMELINE_OPTIONS = [
	{ key: "2_weeks", label: "2 Weeks" },
	{ key: "4_6_weeks", label: "4-6 Weeks" },
	{ key: "6_8_weeks", label: "6-8 Weeks" },
	{ key: "8_12_weeks", label: "8-12 Weeks" },
	{ key: "12_14_weeks", label: "12-14 Weeks" },
	{ key: "6_months_plus", label: "6+ Months" },
	{ key: "flexible", label: "Flexible" },
];

const inquirySchema = new mongoose.Schema(
	{
		// Contact Information
		name: {
			type: String,
			required: [true, "Name is required"],
			trim: true,
			maxlength: [100, "Name cannot exceed 100 characters"],
		},
		email: {
			type: String,
			required: [true, "Email is required"],
			lowercase: true,
			trim: true,
			match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, "Please enter a valid email"],
		},
		phone: { type: String, trim: true, maxlength: [20, "Phone number cannot exceed 20 characters"] },
		company: { type: String, trim: true, maxlength: [100, "Company name cannot exceed 100 characters"] },
		website: { type: String, trim: true, maxlength: [200, "Website URL cannot exceed 200 characters"] },

		// Subject / plan name submitted with the inquiry
		subject: { type: String, trim: true, maxlength: [200, "Subject cannot exceed 200 characters"] },

		// Project Details
		projectType: {
			type: String,
			enum: { values: SERVICE_OPTIONS.map((t) => t.key), message: "{VALUE} is not a valid project type" },
			required: [true, "Project type is required"],
		},
		budget: {
			type: String,
			enum: { values: BUDGET_RANGES.map((t) => t.key), message: "{VALUE} is not a valid budget range" },
			required: [true, "Budget is required"],
		},
		timeline: {
			type: String,
			enum: { values: TIMELINE_OPTIONS.map((t) => t.key), message: "{VALUE} is not a valid timeline" },
			required: [true, "Timeline is required"],
		},
		description: {
			type: String,
			required: [true, "Description is required"],
			maxlength: [5000, "Description cannot exceed 5000 characters"],
		},
		requirements: [{ type: String, trim: true }],
		attachments: [{ filename: String, url: String, size: Number, uploadedAt: { type: Date, default: Date.now } }],

		// Communication preference
		preferredContactMethod: {
			type: String,
			enum: { values: ["Email", "Phone", "WhatsApp"], message: "{VALUE} is not a valid contact method" },
			default: "Email",
		},

		// Client consent (from form submission)
		newsletterOptIn: { type: Boolean, default: false },
		privacyConsent: { type: Boolean, default: false },

		// Admin tags for categorization
		tags: [{ type: String, trim: true, maxlength: 50 }],

		// CRM lifecycle tracking
		proposalSent: { type: Boolean, default: false },
		proposalSentAt: { type: Date },
		proposalUrl: { type: String, trim: true },
		meetingScheduledAt: { type: Date },
		contractSignedAt: { type: Date },
		projectStartedAt: { type: Date },
		projectCompletedAt: { type: Date },

		// Estimated deal value set by admin (INR)
		estimatedProjectValue: { type: Number, min: 0 },

		// Sequential identifier for tracking inquiries
		inquiryNumber: { type: Number, unique: true, index: true },

		// Status & Assignment
		status: {
			type: String,
			enum: {
				values: [
					"new",
					"reviewing",
					"contacted",
					"quoted",
					"negotiating",
					"accepted",
					"rejected",
					"completed",
					"cancelled",
				],
				message: "{VALUE} is not a valid status",
			},
			default: "new",
		},
		priority: {
			type: String,
			enum: { values: ["low", "medium", "high", "urgent"], message: "{VALUE} is not a valid priority" },
			default: "medium",
		},
		assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },

		// Quoting
		quotedAmount: { type: Number, min: 0 },
		quotedCurrency: { type: String, default: "USD", maxlength: 3 },
		quotedAt: { type: Date },
		quotedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },

		// Notes and History
		notes: [
			{
				content: { type: String, required: true, maxlength: 2000 },
				createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
				createdAt: { type: Date, default: Date.now },
				isInternal: { type: Boolean, default: true },
			},
		],

		// Status History for tracking changes
		statusHistory: [
			{
				status: String,
				changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
				changedAt: { type: Date, default: Date.now },
				note: String,
			},
		],

		// Follow-up
		nextFollowUp: { type: Date },
		lastContactedAt: { type: Date },

		// Metadata
		ipAddress: { type: String },
		userAgent: { type: String },
		source: { type: String, enum: ["website", "referral", "social", "email", "phone", "other"], default: "website" },
		referrer: { type: String },

		// Soft delete
		isDeleted: { type: Boolean, default: false },
		deletedAt: { type: Date },
	},
	{ timestamps: true },
);

// Indexes
inquirySchema.index({ status: 1 });
inquirySchema.index({ priority: 1 });
inquirySchema.index({ projectType: 1 });
inquirySchema.index({ createdAt: -1 });
inquirySchema.index({ assignedTo: 1 });
inquirySchema.index({ email: 1 });
inquirySchema.index({ isDeleted: 1 });
inquirySchema.index({ nextFollowUp: 1 });
inquirySchema.index({ tags: 1 });
inquirySchema.index({ proposalSent: 1 });
inquirySchema.index({ newsletterOptIn: 1 });

// Text search
inquirySchema.index({
  name: 'text',
  email: 'text',
  company: 'text',
  subject: 'text',
  description: 'text'
}, {
  name: 'InquiryTextIndex'
});

// Auto-set priority based on budget and assign a sequential inquiry number
inquirySchema.pre('save', async function (next) {
  if (this.isNew) {
    // --- sequential number logic ------------------------------------------------
    try {
      const counter = await Counter.findOneAndUpdate(
        { name: 'inquiry' },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
      );
      this.inquiryNumber = counter.seq;
    } catch (err) {
      return next(err);
    }

    // --- priority logic ---------------------------------------------------------
    const highBudgets = ['500k_1500k', '1500k_plus'];
    const mediumBudgets = ['150k_500k', '50k_150k'];

    if (highBudgets.includes(this.budget)) {
      this.priority = 'high';
    } else if (mediumBudgets.includes(this.budget)) {
      this.priority = 'medium';
    }

    // Short timeline increases priority
    if (this.timeline === '2_weeks' && this.priority !== 'urgent') {
      this.priority = this.priority === 'high' ? 'urgent' : 'high';
    }
  }
  next();
});

// Change status with history tracking
inquirySchema.methods.changeStatus = async function (newStatus, adminId, note = '') {
  this.statusHistory.push({
    status: this.status,
    changedBy: adminId,
    changedAt: new Date(),
    note
  });
  this.status = newStatus;
  return this.save();
};

// Add note
inquirySchema.methods.addNote = async function (content, adminId, isInternal = true) {
  this.notes.push({
    content,
    createdBy: adminId,
    createdAt: new Date(),
    isInternal
  });
  return this.save();
};

// Set quote
inquirySchema.methods.setQuote = async function (amount, currency, adminId) {
  this.quotedAmount = amount;
  this.quotedCurrency = currency;
  this.quotedAt = new Date();
  this.quotedBy = adminId;
  this.status = 'quoted';
  return this.save();
};

// Assign to admin
inquirySchema.methods.assignTo = async function (adminId, assignedByAdminId) {
  this.assignedTo = adminId;
  this.statusHistory.push({
    status: `assigned to ${adminId}`,
    changedBy: assignedByAdminId,
    changedAt: new Date()
  });
  if (this.status === 'new') {
    this.status = 'reviewing';
  }
  return this.save();
};

// Soft delete
inquirySchema.methods.softDelete = async function () {
  this.isDeleted = true;
  this.deletedAt = new Date();
  return this.save();
};

// Static: find active inquiries
inquirySchema.statics.findActive = function (filter = {}) {
  return this.find({ ...filter, isDeleted: false });
};

// Static: find due for follow-up
inquirySchema.statics.findDueForFollowUp = function () {
  return this.find({
    isDeleted: false,
    nextFollowUp: { $lte: new Date() },
    status: { $nin: ['completed', 'cancelled', 'rejected'] }
  });
};

// Static: count by status
inquirySchema.statics.countByStatus = async function () {
  return this.aggregate([
    { $match: { isDeleted: false } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);
};

const Inquiry = mongoose.model('Inquiry', inquirySchema);

export default Inquiry;