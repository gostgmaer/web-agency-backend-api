import mongoose from 'mongoose';

const newsletterSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
  },
  name: {
    type: String,
    trim: true,
    maxlength: [100, 'Name cannot exceed 100 characters']
  },
  isActive: {
    type: Boolean,
    default: true
  },
  subscribedAt: {
    type: Date,
    default: Date.now
  },
  unsubscribedAt: {
    type: Date
  },
  source: {
    type: String,
    enum: ['website', 'blog', 'popup', 'footer', 'admin', 'import', 'api'],
    default: 'website'
  },

  // Preferences
  preferences: {
    frequency: {
      type: String,
      enum: ['daily', 'weekly', 'monthly'],
      default: 'weekly'
    },
    categories: [{
      type: String,
      trim: true
    }]
  },

  // Engagement tracking
  emailsSent: {
    type: Number,
    default: 0
  },
  emailsOpened: {
    type: Number,
    default: 0
  },
  emailsClicked: {
    type: Number,
    default: 0
  },
  lastEmailSentAt: {
    type: Date
  },
  lastEmailOpenedAt: {
    type: Date
  },

  // Confirmation
  isConfirmed: {
    type: Boolean,
    default: false // For double opt-in
  },
  confirmationToken: {
    type: String,
    select: false
  },
  confirmedAt: {
    type: Date
  },

  // Unsubscribe tracking
  unsubscribeReason: {
    type: String,
    enum: ['too-many', 'not-relevant', 'never-subscribed', 'other'],
  },
  unsubscribeFeedback: {
    type: String,
    maxlength: 500
  },

  // Tags for segmentation
  tags: [{
    type: String,
    trim: true,
    lowercase: true
  }],

  // Metadata
  ipAddress: {
    type: String
  },
  userAgent: {
    type: String
  },

  // Bounce/complaint tracking
  bounceCount: {
    type: Number,
    default: 0
  },
  lastBounceAt: {
    type: Date
  },
  isComplaint: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Indexes
newsletterSchema.index({ isActive: 1 });
// email already unique on the schema
newsletterSchema.index({ isConfirmed: 1 });
newsletterSchema.index({ createdAt: -1 });
newsletterSchema.index({ tags: 1 });
newsletterSchema.index({ 'preferences.categories': 1 });

// Generate confirmation token
newsletterSchema.methods.generateConfirmationToken = async function () {
  const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
  this.confirmationToken = token;
  return this.save();
};

// Confirm subscription
newsletterSchema.methods.confirmSubscription = async function () {
  this.isConfirmed = true;
  this.confirmedAt = new Date();
  this.confirmationToken = undefined;
  return this.save();
};

// Unsubscribe
newsletterSchema.methods.unsubscribe = async function (reason = null, feedback = null) {
  this.isActive = false;
  this.unsubscribedAt = new Date();
  if (reason) this.unsubscribeReason = reason;
  if (feedback) this.unsubscribeFeedback = feedback;
  return this.save();
};

// Resubscribe
newsletterSchema.methods.resubscribe = async function () {
  this.isActive = true;
  this.subscribedAt = new Date();
  this.unsubscribedAt = null;
  this.unsubscribeReason = undefined;
  this.unsubscribeFeedback = undefined;
  return this.save();
};

// Track email sent
newsletterSchema.methods.trackEmailSent = async function () {
  this.emailsSent += 1;
  this.lastEmailSentAt = new Date();
  return this.save();
};

// Track email opened
newsletterSchema.methods.trackEmailOpened = async function () {
  this.emailsOpened += 1;
  this.lastEmailOpenedAt = new Date();
  return this.save();
};

// Track email clicked
newsletterSchema.methods.trackEmailClicked = async function () {
  this.emailsClicked += 1;
  return this.save();
};

// Record bounce
newsletterSchema.methods.recordBounce = async function () {
  this.bounceCount += 1;
  this.lastBounceAt = new Date();

  // Auto-deactivate after 3 bounces
  if (this.bounceCount >= 3) {
    this.isActive = false;
  }

  return this.save();
};

// Virtual for open rate
newsletterSchema.virtual('openRate').get(function () {
  if (this.emailsSent === 0) return 0;
  return Math.round((this.emailsOpened / this.emailsSent) * 100);
});

// Virtual for click rate
newsletterSchema.virtual('clickRate').get(function () {
  if (this.emailsOpened === 0) return 0;
  return Math.round((this.emailsClicked / this.emailsOpened) * 100);
});

// Static: find active subscribers
newsletterSchema.statics.findActiveSubscribers = function (filter = {}) {
  return this.find({
    ...filter,
    isActive: true,
    isConfirmed: true // Only confirmed subscribers
  });
};

// Static: get subscriber stats
newsletterSchema.statics.getStats = async function () {
  const stats = await this.aggregate([
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        active: { $sum: { $cond: ['$isActive', 1, 0] } },
        confirmed: { $sum: { $cond: ['$isConfirmed', 1, 0] } },
        totalEmailsSent: { $sum: '$emailsSent' },
        totalOpened: { $sum: '$emailsOpened' },
        totalClicked: { $sum: '$emailsClicked' }
      }
    }
  ]);

  return stats[0] || { total: 0, active: 0, confirmed: 0 };
};

const Newsletter = mongoose.model('Newsletter', newsletterSchema);

export default Newsletter;