import mongoose from 'mongoose';

const inquirySchema = new mongoose.Schema({
  // Contact Information
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    maxlength: [100, 'Name cannot exceed 100 characters']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    lowercase: true,
    trim: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
  },
  phone: {
    type: String,
    trim: true,
    maxlength: [20, 'Phone number cannot exceed 20 characters']
  },
  company: {
    type: String,
    trim: true,
    maxlength: [100, 'Company name cannot exceed 100 characters']
  },
  website: {
    type: String,
    trim: true,
    maxlength: [200, 'Website URL cannot exceed 200 characters']
  },

  // Project Details
  projectType: {
    type: String,
    enum: {
      values: ['website', 'webapp', 'mobile', 'ecommerce', 'redesign', 'maintenance', 'consulting', 'other'],
      message: '{VALUE} is not a valid project type'
    },
    required: [true, 'Project type is required']
  },
  budget: {
    type: String,
    enum: {
      values: ['under-5k', '5k-10k', '10k-25k', '25k-50k', '50k-100k', 'over-100k', 'not-sure'],
      message: '{VALUE} is not a valid budget range'
    },
    required: [true, 'Budget is required']
  },
  timeline: {
    type: String,
    enum: {
      values: ['asap', '1-month', '2-3months', '3-6months', '6months+', 'flexible'],
      message: '{VALUE} is not a valid timeline'
    },
    required: [true, 'Timeline is required']
  },
  description: {
    type: String,
    required: [true, 'Description is required'],
    maxlength: [5000, 'Description cannot exceed 5000 characters']
  },
  requirements: [{
    type: String,
    trim: true
  }],
  attachments: [{
    filename: String,
    url: String,
    size: Number,
    uploadedAt: { type: Date, default: Date.now }
  }],

  // Status & Assignment
  status: {
    type: String,
    enum: {
      values: ['new', 'reviewing', 'contacted', 'quoted', 'negotiating', 'accepted', 'rejected', 'completed', 'cancelled'],
      message: '{VALUE} is not a valid status'
    },
    default: 'new'
  },
  priority: {
    type: String,
    enum: {
      values: ['low', 'medium', 'high', 'urgent'],
      message: '{VALUE} is not a valid priority'
    },
    default: 'medium'
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },

  // Quoting
  quotedAmount: {
    type: Number,
    min: 0
  },
  quotedCurrency: {
    type: String,
    default: 'USD',
    maxlength: 3
  },
  quotedAt: {
    type: Date
  },
  quotedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },

  // Notes and History
  notes: [{
    content: {
      type: String,
      required: true,
      maxlength: 2000
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: true
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    isInternal: {
      type: Boolean,
      default: true
    }
  }],

  // Status History for tracking changes
  statusHistory: [{
    status: String,
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin'
    },
    changedAt: {
      type: Date,
      default: Date.now
    },
    note: String
  }],

  // Follow-up
  nextFollowUp: {
    type: Date
  },
  lastContactedAt: {
    type: Date
  },

  // Metadata
  ipAddress: {
    type: String
  },
  userAgent: {
    type: String
  },
  source: {
    type: String,
    enum: ['website', 'referral', 'social', 'email', 'phone', 'other'],
    default: 'website'
  },
  referrer: {
    type: String
  },

  // Soft delete
  isDeleted: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Indexes
inquirySchema.index({ status: 1 });
inquirySchema.index({ priority: 1 });
inquirySchema.index({ projectType: 1 });
inquirySchema.index({ createdAt: -1 });
inquirySchema.index({ assignedTo: 1 });
inquirySchema.index({ email: 1 });
inquirySchema.index({ isDeleted: 1 });
inquirySchema.index({ nextFollowUp: 1 });

// Text search
inquirySchema.index({
  name: 'text',
  email: 'text',
  company: 'text',
  description: 'text'
}, {
  name: 'InquiryTextIndex'
});

// Auto-set priority based on budget
inquirySchema.pre('save', function (next) {
  if (this.isNew) {
    // Set priority based on budget
    const highBudgets = ['50k-100k', 'over-100k'];
    const mediumBudgets = ['25k-50k', '10k-25k'];

    if (highBudgets.includes(this.budget)) {
      this.priority = 'high';
    } else if (mediumBudgets.includes(this.budget)) {
      this.priority = 'medium';
    }

    // ASAP timeline increases priority
    if (this.timeline === 'asap' && this.priority !== 'urgent') {
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