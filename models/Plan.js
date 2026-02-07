import mongoose from 'mongoose';

const planSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Plan name is required'],
    trim: true,
    maxlength: [100, 'Name cannot exceed 100 characters']
  },
  slug: {
    type: String,
    required: [true, 'Slug is required'],
    unique: true,
    lowercase: true,
    trim: true,
    maxlength: [120, 'Slug cannot exceed 120 characters']
  },
  description: {
    type: String,
    required: [true, 'Description is required'],
    maxlength: [1000, 'Description cannot exceed 1000 characters']
  },
  shortDescription: {
    type: String,
    maxlength: [200, 'Short description cannot exceed 200 characters']
  },

  // Pricing
  price: {
    type: Number,
    required: [true, 'Price is required'],
    min: [0, 'Price cannot be negative']
  },
  originalPrice: {
    type: Number,
    min: 0 // For showing discounts
  },
  currency: {
    type: String,
    default: 'USD',
    uppercase: true,
    maxlength: 3
  },
  billingCycle: {
    type: String,
    enum: {
      values: ['monthly', 'quarterly', 'yearly', 'one-time', 'custom'],
      message: '{VALUE} is not a valid billing cycle'
    },
    required: [true, 'Billing cycle is required']
  },

  // Features
  features: [{
    name: {
      type: String,
      required: true,
      trim: true
    },
    included: {
      type: Boolean,
      default: true
    },
    description: {
      type: String,
      trim: true
    },
    value: {
      type: String, // e.g., "5 pages", "Unlimited"
      trim: true
    },
    highlight: {
      type: Boolean,
      default: false
    }
  }],

  // Limits (for comparison)
  limits: {
    pages: { type: Number },
    storage: { type: String }, // e.g., "5GB"
    bandwidth: { type: String },
    revisions: { type: Number },
    supportLevel: {
      type: String,
      enum: ['basic', 'priority', 'dedicated', 'none']
    }
  },

  // Display
  isPopular: {
    type: Boolean,
    default: false
  },
  isFeatured: {
    type: Boolean,
    default: false
  },
  badge: {
    type: String, // e.g., "Best Value", "Most Popular"
    maxlength: 50
  },
  icon: {
    type: String // Icon name or URL
  },
  color: {
    type: String, // Accent color for the plan card
    default: '#3B82F6'
  },

  // Status
  isActive: {
    type: Boolean,
    default: true
  },
  isArchived: {
    type: Boolean,
    default: false
  },

  // Ordering
  order: {
    type: Number,
    default: 0
  },

  // Categorization
  category: {
    type: String,
    enum: {
      values: ['website', 'webapp', 'ecommerce', 'maintenance', 'hosting', 'consulting', 'bundle'],
      message: '{VALUE} is not a valid category'
    },
    required: [true, 'Category is required']
  },
  targetAudience: {
    type: String,
    enum: ['starter', 'small-business', 'enterprise', 'agency'],
    default: 'small-business'
  },

  // CTA
  ctaText: {
    type: String,
    default: 'Get Started',
    maxlength: 50
  },
  ctaUrl: {
    type: String
  },

  // SEO
  metaTitle: {
    type: String,
    maxlength: 70
  },
  metaDescription: {
    type: String,
    maxlength: 160
  },

  // Analytics
  views: {
    type: Number,
    default: 0
  },
  inquiries: {
    type: Number,
    default: 0 // Number of inquiries for this plan
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
planSchema.index({ isActive: 1, isArchived: 1 });
planSchema.index({ category: 1 });
planSchema.index({ order: 1 });
planSchema.index({ slug: 1 });
planSchema.index({ billingCycle: 1 });
planSchema.index({ price: 1 });
planSchema.index({ targetAudience: 1 });

// Virtual for discount percentage
planSchema.virtual('discountPercent').get(function () {
  if (!this.originalPrice || this.originalPrice <= this.price) return 0;
  return Math.round(((this.originalPrice - this.price) / this.originalPrice) * 100);
});

// Virtual for formatted price
planSchema.virtual('formattedPrice').get(function () {
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: this.currency
  });
  return formatter.format(this.price);
});

// Pre-save hook
planSchema.pre('save', function (next) {
  // Set short description from description if not provided
  if (!this.shortDescription && this.description) {
    this.shortDescription = this.description.substring(0, 200);
  }

  // Set meta title from name if not provided
  if (!this.metaTitle) {
    this.metaTitle = `${this.name} - Web Development Plan`;
  }

  // Set meta description if not provided
  if (!this.metaDescription && this.shortDescription) {
    this.metaDescription = this.shortDescription;
  }

  next();
});

// Track view
planSchema.methods.trackView = async function () {
  this.views += 1;
  return this.save();
};

// Track inquiry
planSchema.methods.trackInquiry = async function () {
  this.inquiries += 1;
  return this.save();
};

// Archive plan
planSchema.methods.archive = async function () {
  this.isArchived = true;
  this.isActive = false;
  return this.save();
};

// Restore plan
planSchema.methods.restore = async function () {
  this.isArchived = false;
  this.isActive = true;
  return this.save();
};

// Duplicate plan
planSchema.methods.duplicate = async function (newSlug) {
  const Plan = mongoose.model('Plan');
  const planData = this.toObject();

  delete planData._id;
  delete planData.createdAt;
  delete planData.updatedAt;
  planData.slug = newSlug;
  planData.name = `${planData.name} (Copy)`;
  planData.views = 0;
  planData.inquiries = 0;
  planData.isActive = false;

  return Plan.create(planData);
};

// Static: find active plans
planSchema.statics.findActive = function (filter = {}) {
  return this.find({
    ...filter,
    isActive: true,
    isArchived: false
  }).sort({ order: 1 });
};

// Static: find by category
planSchema.statics.findByCategory = function (category) {
  return this.find({
    category,
    isActive: true,
    isArchived: false
  }).sort({ order: 1 });
};

// Static: compare plans
planSchema.statics.compareFeatures = async function (planIds) {
  const plans = await this.find({ _id: { $in: planIds } });

  // Get all unique feature names
  const allFeatures = new Set();
  plans.forEach(plan => {
    plan.features.forEach(f => allFeatures.add(f.name));
  });

  // Build comparison matrix
  const comparison = Array.from(allFeatures).map(featureName => {
    const row = { feature: featureName };
    plans.forEach(plan => {
      const feature = plan.features.find(f => f.name === featureName);
      row[plan.slug] = feature ? {
        included: feature.included,
        value: feature.value || (feature.included ? '✓' : '✗')
      } : { included: false, value: '✗' };
    });
    return row;
  });

  return { plans, comparison };
};

const Plan = mongoose.model('Plan', planSchema);

export default Plan;