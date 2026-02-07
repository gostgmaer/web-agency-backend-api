import mongoose from 'mongoose';

const blogSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Title is required'],
    trim: true,
    maxlength: [200, 'Title cannot exceed 200 characters']
  },
  slug: {
    type: String,
    required: [true, 'Slug is required'],
    unique: true,
    lowercase: true,
    trim: true,
    maxlength: [250, 'Slug cannot exceed 250 characters']
  },
  content: {
    type: String,
    required: [true, 'Content is required']
  },
  excerpt: {
    type: String,
    required: [true, 'Excerpt is required'],
    maxlength: [500, 'Excerpt cannot exceed 500 characters']
  },
  featuredImage: {
    type: String,
    default: null
  },
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    required: [true, 'Author is required']
  },
  categories: [{
    type: String,
    trim: true,
    lowercase: true
  }],
  tags: [{
    type: String,
    trim: true,
    lowercase: true
  }],
  isPublished: {
    type: Boolean,
    default: false
  },
  publishedAt: {
    type: Date
  },
  views: {
    type: Number,
    default: 0,
    min: 0
  },
  likes: {
    type: Number,
    default: 0,
    min: 0
  },
  readingTime: {
    type: Number, // in minutes
    default: 0
  },
  metaTitle: {
    type: String,
    maxlength: [70, 'Meta title cannot exceed 70 characters']
  },
  metaDescription: {
    type: String,
    maxlength: [160, 'Meta description cannot exceed 160 characters']
  },
  metaKeywords: [{
    type: String,
    trim: true
  }],
  isDeleted: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for efficient querying
blogSchema.index({ isPublished: 1, isDeleted: 1 });
blogSchema.index({ categories: 1 });
blogSchema.index({ tags: 1 });
blogSchema.index({ publishedAt: -1 });
blogSchema.index({ slug: 1 });
blogSchema.index({ author: 1 });
blogSchema.index({ createdAt: -1 });

// Text search index for title, content, excerpt
blogSchema.index({
  title: 'text',
  excerpt: 'text',
  content: 'text'
}, {
  weights: {
    title: 10,
    excerpt: 5,
    content: 1
  },
  name: 'BlogTextIndex'
});

// Calculate reading time based on content
blogSchema.pre('save', function (next) {
  // Set publishedAt when first published
  if (this.isPublished && !this.publishedAt) {
    this.publishedAt = new Date();
  }

  // Calculate reading time (average 200 words per minute)
  if (this.isModified('content')) {
    const wordCount = this.content.split(/\s+/).length;
    this.readingTime = Math.ceil(wordCount / 200);
  }

  // Set meta title from title if not provided
  if (!this.metaTitle && this.title) {
    this.metaTitle = this.title.substring(0, 70);
  }

  // Set meta description from excerpt if not provided
  if (!this.metaDescription && this.excerpt) {
    this.metaDescription = this.excerpt.substring(0, 160);
  }

  next();
});

// Soft delete method
blogSchema.methods.softDelete = async function (adminId) {
  this.isDeleted = true;
  this.deletedAt = new Date();
  this.deletedBy = adminId;
  return this.save();
};

// Restore soft deleted blog
blogSchema.methods.restore = async function () {
  this.isDeleted = false;
  this.deletedAt = undefined;
  this.deletedBy = undefined;
  return this.save();
};

// Custom toJSON to clean up output
blogSchema.methods.toJSON = function () {
  const blog = this.toObject();
  delete blog.__v;
  return blog;
};

// Static method to find published blogs
blogSchema.statics.findPublished = function (filter = {}) {
  return this.find({
    ...filter,
    isPublished: true,
    isDeleted: false
  });
};

// Static method for text search
blogSchema.statics.search = function (query, options = {}) {
  const { page = 1, limit = 10 } = options;
  const skip = (page - 1) * limit;

  return this.find(
    {
      $text: { $search: query },
      isPublished: true,
      isDeleted: false
    },
    { score: { $meta: 'textScore' } }
  )
    .sort({ score: { $meta: 'textScore' } })
    .skip(skip)
    .limit(limit)
    .populate('author', 'name email');
};

const Blog = mongoose.model('Blog', blogSchema);

export default Blog;