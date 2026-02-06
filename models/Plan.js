import mongoose from 'mongoose';

const planSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  slug: {
    type: String,
    required: true,
    unique: true
  },
  description: {
    type: String,
    required: true
  },
  price: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    default: 'USD'
  },
  billingCycle: {
    type: String,
    enum: ['monthly', 'yearly', 'one-time'],
    required: true
  },
  features: [{
    name: String,
    included: Boolean,
    description: String
  }],
  isPopular: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  },
  order: {
    type: Number,
    default: 0
  },
  category: {
    type: String,
    enum: ['website', 'maintenance', 'hosting', 'consulting'],
    required: true
  }
}, {
  timestamps: true
});

planSchema.index({ isActive: 1 });
planSchema.index({ category: 1 });
planSchema.index({ order: 1 });

const Plan = mongoose.model('Plan', planSchema);

export default Plan;