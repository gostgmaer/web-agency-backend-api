import mongoose from 'mongoose';

const inquirySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true,
    lowercase: true
  },
  phone: {
    type: String
  },
  company: {
    type: String
  },
  projectType: {
    type: String,
    enum: ['website', 'webapp', 'mobile', 'ecommerce', 'other'],
    required: true
  },
  budget: {
    type: String,
    enum: ['under-5k', '5k-10k', '10k-25k', '25k-50k', 'over-50k'],
    required: true
  },
  timeline: {
    type: String,
    enum: ['asap', '1-month', '2-3months', '3-6months', 'flexible'],
    required: true
  },
  description: {
    type: String,
    required: true
  },
  requirements: [{
    type: String
  }],
  status: {
    type: String,
    enum: ['new', 'reviewing', 'quoted', 'accepted', 'rejected', 'completed'],
    default: 'new'
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium'
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  notes: [{
    content: String,
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin'
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  ipAddress: {
    type: String
  },
  userAgent: {
    type: String
  }
}, {
  timestamps: true
});

inquirySchema.index({ status: 1 });
inquirySchema.index({ priority: 1 });
inquirySchema.index({ projectType: 1 });
inquirySchema.index({ createdAt: -1 });

const Inquiry = mongoose.model('Inquiry', inquirySchema);

export default Inquiry;