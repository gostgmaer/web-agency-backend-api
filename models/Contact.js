import mongoose from 'mongoose';

const contactSchema = new mongoose.Schema({
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
  subject: {
    type: String,
    required: [true, 'Subject is required'],
    trim: true,
    maxlength: [200, 'Subject cannot exceed 200 characters']
  },
  message: {
    type: String,
    required: [true, 'Message is required'],
    trim: true,
    maxlength: [5000, 'Message cannot exceed 5000 characters']
  },
  status: {
    type: String,
    enum: {
      values: ['new', 'read', 'replied', 'closed', 'spam'],
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
  // Admin reply tracking
  repliedAt: {
    type: Date
  },
  repliedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  replyMessage: {
    type: String,
    maxlength: [5000, 'Reply cannot exceed 5000 characters']
  },
  // Admin notes (internal)
  adminNotes: {
    type: String,
    maxlength: [1000, 'Notes cannot exceed 1000 characters']
  },
  // Source tracking
  source: {
    type: String,
    enum: ['website', 'email', 'phone', 'referral', 'other'],
    default: 'website'
  },
  referrer: {
    type: String // URL that referred the user
  },
  // Metadata
  ipAddress: {
    type: String
  },
  userAgent: {
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
contactSchema.index({ status: 1 });
contactSchema.index({ priority: 1 });
contactSchema.index({ createdAt: -1 });
contactSchema.index({ email: 1 });
contactSchema.index({ isDeleted: 1 });

// Text search index
contactSchema.index({
  name: 'text',
  email: 'text',
  subject: 'text',
  message: 'text'
}, {
  name: 'ContactTextIndex'
});

// Auto-set priority based on keywords
contactSchema.pre('save', function (next) {
  if (this.isNew) {
    const urgentKeywords = ['urgent', 'asap', 'emergency', 'immediately', 'critical'];
    const highKeywords = ['important', 'priority', 'soon', 'quick'];

    const messageAndSubject = (this.message + ' ' + this.subject).toLowerCase();

    if (urgentKeywords.some(kw => messageAndSubject.includes(kw))) {
      this.priority = 'urgent';
    } else if (highKeywords.some(kw => messageAndSubject.includes(kw))) {
      this.priority = 'high';
    }
  }
  next();
});

// Mark as read
contactSchema.methods.markAsRead = async function () {
  if (this.status === 'new') {
    this.status = 'read';
    return this.save();
  }
  return this;
};

// Reply to contact
contactSchema.methods.reply = async function (adminId, replyMessage) {
  this.status = 'replied';
  this.repliedAt = new Date();
  this.repliedBy = adminId;
  this.replyMessage = replyMessage;
  return this.save();
};

// Mark as spam
contactSchema.methods.markAsSpam = async function () {
  this.status = 'spam';
  return this.save();
};

// Soft delete
contactSchema.methods.softDelete = async function () {
  this.isDeleted = true;
  this.deletedAt = new Date();
  return this.save();
};

// Static: find active (not deleted) contacts
contactSchema.statics.findActive = function (filter = {}) {
  return this.find({ ...filter, isDeleted: false });
};

// Static: count by status
contactSchema.statics.countByStatus = async function () {
  return this.aggregate([
    { $match: { isDeleted: false } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);
};

const Contact = mongoose.model('Contact', contactSchema);

export default Contact;