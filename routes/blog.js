import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { validateRequest, sanitizeInput } from '../middleware/validation.js';
import {
  createBlogValidation,
  updateBlogValidation,
  blogIdValidation,
  blogSlugValidation
} from '../validation/blogValidation.js';
import { getPaginationParams, getPaginationMeta } from '../utils/pagination.js';
import Blog from '../models/Blog.js';
import logger from '../utils/logger.js';
import { NotFoundError, BadRequestError } from '../utils/errors.js';

const router = express.Router();

/**
 * @swagger
 * /api/blogs:
 *   get:
 *     summary: Get published blogs
 *     tags: [Blog]
 */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, skip } = getPaginationParams(req);
    const { category, tag, search, sort } = req.query;

    let filter = { isPublished: true, isDeleted: false };

    if (category) {
      filter.categories = { $in: [category.toLowerCase()] };
    }

    if (tag) {
      filter.tags = { $in: [tag.toLowerCase()] };
    }

    // Handle search with text index or regex fallback
    let query;
    if (search) {
      // Try text search first
      filter.$text = { $search: search };
      query = Blog.find(filter, { score: { $meta: 'textScore' } });
    } else {
      query = Blog.find(filter);
    }

    // Sorting options
    let sortOption = { publishedAt: -1 }; // Default
    if (sort === 'views') sortOption = { views: -1 };
    else if (sort === 'likes') sortOption = { likes: -1 };
    else if (sort === 'oldest') sortOption = { publishedAt: 1 };
    else if (search) sortOption = { score: { $meta: 'textScore' } };

    const total = await Blog.countDocuments(filter);
    const blogs = await query
      .populate('author', 'name email avatar')
      .select('-content') // Exclude full content in list view
      .sort(sortOption)
      .skip(skip)
      .limit(limit);

    const pagination = getPaginationMeta(total, page, limit);

    res.json({
      success: true,
      message: 'Blogs retrieved successfully',
      data: {
        blogs,
        pagination
      }
    });
  } catch (error) {
    // If text index doesn't exist, fallback to regex
    if (error.code === 27) {
      const { page, limit, skip } = getPaginationParams(req);
      const { search } = req.query;

      const filter = {
        isPublished: true,
        isDeleted: false,
        $or: [
          { title: { $regex: search, $options: 'i' } },
          { excerpt: { $regex: search, $options: 'i' } }
        ]
      };

      const total = await Blog.countDocuments(filter);
      const blogs = await Blog.find(filter)
        .populate('author', 'name email avatar')
        .select('-content')
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(limit);

      return res.json({
        success: true,
        data: {
          blogs,
          pagination: getPaginationMeta(total, page, limit)
        }
      });
    }
    next(error);
  }
});

/**
 * @swagger
 * /api/blogs/featured:
 *   get:
 *     summary: Get featured/popular blogs
 *     tags: [Blog]
 */
router.get('/featured', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 5;

    const blogs = await Blog.find({
      isPublished: true,
      isDeleted: false
    })
      .populate('author', 'name avatar')
      .select('title slug excerpt featuredImage views likes readingTime publishedAt')
      .sort({ views: -1, likes: -1 })
      .limit(limit);

    res.json({
      success: true,
      message: 'Featured blogs retrieved',
      data: { blogs }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/blogs/categories:
 *   get:
 *     summary: Get all blog categories with counts
 *     tags: [Blog]
 */
router.get('/categories', async (req, res, next) => {
  try {
    const categories = await Blog.aggregate([
      { $match: { isPublished: true, isDeleted: false } },
      { $unwind: '$categories' },
      { $group: { _id: '$categories', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    res.json({
      success: true,
      message: 'Categories retrieved',
      data: { categories }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/blogs/tags:
 *   get:
 *     summary: Get all blog tags with counts
 *     tags: [Blog]
 */
router.get('/tags', async (req, res, next) => {
  try {
    const tags = await Blog.aggregate([
      { $match: { isPublished: true, isDeleted: false } },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 50 }
    ]);

    res.json({
      success: true,
      message: 'Tags retrieved',
      data: { tags }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/blogs/admin:
 *   get:
 *     summary: Get all blogs including drafts (Admin only)
 *     tags: [Blog]
 *     security:
 *       - bearerAuth: []
 */
router.get('/admin', authenticate, async (req, res, next) => {
  try {
    const { page, limit, skip } = getPaginationParams(req);
    const { status, search } = req.query;

    let filter = { isDeleted: false };

    if (status === 'published') filter.isPublished = true;
    else if (status === 'draft') filter.isPublished = false;

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { excerpt: { $regex: search, $options: 'i' } }
      ];
    }

    const total = await Blog.countDocuments(filter);
    const blogs = await Blog.find(filter)
      .populate('author', 'name email avatar')
      .select('-content')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const pagination = getPaginationMeta(total, page, limit);

    res.json({
      success: true,
      message: 'Blogs retrieved',
      data: { blogs, pagination }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/blogs/{slug}:
 *   get:
 *     summary: Get blog by slug
 *     tags: [Blog]
 */
router.get('/:slug', blogSlugValidation, validateRequest, async (req, res, next) => {
  try {
    const blog = await Blog.findOne({
      slug: req.params.slug,
      isPublished: true,
      isDeleted: false
    }).populate('author', 'name email avatar');

    if (!blog) {
      throw new NotFoundError('Blog post');
    }

    // Increment views
    blog.views += 1;
    await blog.save();

    // Get related blogs
    const relatedBlogs = await Blog.find({
      _id: { $ne: blog._id },
      isPublished: true,
      isDeleted: false,
      $or: [
        { categories: { $in: blog.categories } },
        { tags: { $in: blog.tags } }
      ]
    })
      .select('title slug excerpt featuredImage readingTime publishedAt')
      .limit(3);

    res.json({
      success: true,
      message: 'Blog retrieved successfully',
      data: {
        blog,
        relatedBlogs
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/blogs/{id}/like:
 *   post:
 *     summary: Like a blog post
 *     tags: [Blog]
 */
router.post('/:id/like', blogIdValidation, validateRequest, async (req, res, next) => {
  try {
    const blog = await Blog.findOneAndUpdate(
      { _id: req.params.id, isPublished: true, isDeleted: false },
      { $inc: { likes: 1 } },
      { new: true }
    );

    if (!blog) {
      throw new NotFoundError('Blog post');
    }

    res.json({
      success: true,
      message: 'Blog liked',
      data: { likes: blog.likes }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/blogs:
 *   post:
 *     summary: Create new blog (Admin only)
 *     tags: [Blog]
 *     security:
 *       - bearerAuth: []
 */
router.post('/', authenticate, createBlogValidation, validateRequest, sanitizeInput, async (req, res, next) => {
  try {
    const blogData = {
      ...req.body,
      author: req.admin._id
    };

    const blog = new Blog(blogData);
    await blog.save();
    await blog.populate('author', 'name email avatar');

    logger.info('Blog created', {
      blogId: blog._id,
      title: blog.title,
      isPublished: blog.isPublished,
      createdBy: req.admin.email
    });

    res.status(201).json({
      success: true,
      message: 'Blog created successfully',
      data: { blog }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/blogs/{id}:
 *   put:
 *     summary: Update blog (Admin only)
 *     tags: [Blog]
 *     security:
 *       - bearerAuth: []
 */
router.put('/:id', authenticate, updateBlogValidation, validateRequest, sanitizeInput, async (req, res, next) => {
  try {
    const blog = await Blog.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      req.body,
      { new: true, runValidators: true }
    ).populate('author', 'name email avatar');

    if (!blog) {
      throw new NotFoundError('Blog');
    }

    logger.info('Blog updated', {
      blogId: blog._id,
      title: blog.title,
      updatedBy: req.admin.email
    });

    res.json({
      success: true,
      message: 'Blog updated successfully',
      data: { blog }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/blogs/{id}/publish:
 *   patch:
 *     summary: Publish/unpublish blog (Admin only)
 *     tags: [Blog]
 *     security:
 *       - bearerAuth: []
 */
router.patch('/:id/publish', authenticate, blogIdValidation, validateRequest, async (req, res, next) => {
  try {
    const { isPublished } = req.body;

    if (typeof isPublished !== 'boolean') {
      throw new BadRequestError('isPublished must be a boolean');
    }

    const updateData = { isPublished };
    if (isPublished) {
      updateData.publishedAt = new Date();
    }

    const blog = await Blog.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      updateData,
      { new: true }
    );

    if (!blog) {
      throw new NotFoundError('Blog');
    }

    logger.info(`Blog ${isPublished ? 'published' : 'unpublished'}`, {
      blogId: blog._id,
      updatedBy: req.admin.email
    });

    res.json({
      success: true,
      message: isPublished ? 'Blog published successfully' : 'Blog unpublished',
      data: { blog }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/blogs/{id}:
 *   delete:
 *     summary: Delete blog (Admin only) - Soft delete
 *     tags: [Blog]
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:id', authenticate, blogIdValidation, validateRequest, async (req, res, next) => {
  try {
    const blog = await Blog.findOne({ _id: req.params.id, isDeleted: false });

    if (!blog) {
      throw new NotFoundError('Blog');
    }

    await blog.softDelete(req.admin._id);

    logger.info('Blog deleted', {
      blogId: blog._id,
      title: blog.title,
      deletedBy: req.admin.email
    });

    res.json({
      success: true,
      message: 'Blog deleted successfully',
      data: {}
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/blogs/{id}/restore:
 *   patch:
 *     summary: Restore deleted blog (Admin only)
 *     tags: [Blog]
 *     security:
 *       - bearerAuth: []
 */
router.patch('/:id/restore', authenticate, blogIdValidation, validateRequest, async (req, res, next) => {
  try {
    const blog = await Blog.findOne({ _id: req.params.id, isDeleted: true });

    if (!blog) {
      throw new NotFoundError('Deleted blog');
    }

    await blog.restore();

    logger.info('Blog restored', {
      blogId: blog._id,
      restoredBy: req.admin.email
    });

    res.json({
      success: true,
      message: 'Blog restored successfully',
      data: { blog }
    });
  } catch (error) {
    next(error);
  }
});

export default router;