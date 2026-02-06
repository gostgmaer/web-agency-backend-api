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

const router = express.Router();

/**
 * @swagger
 * /api/blogs:
 *   get:
 *     summary: Get published blogs
 *     tags: [Blog]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *       - in: query
 *         name: tag
 *         schema:
 *           type: string
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Blogs retrieved successfully
 */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, skip } = getPaginationParams(req);
    const { category, tag, search } = req.query;

    let filter = { isPublished: true, isDeleted: false };

    if (category) {
      filter.categories = { $in: [category] };
    }

    if (tag) {
      filter.tags = { $in: [tag] };
    }

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { excerpt: { $regex: search, $options: 'i' } },
        { content: { $regex: search, $options: 'i' } }
      ];
    }

    const total = await Blog.countDocuments(filter);
    const blogs = await Blog.find(filter)
      .populate('author', 'name email')
      .select('-content')
      .sort({ publishedAt: -1 })
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
    next(error);
  }
});

/**
 * @swagger
 * /api/blogs/{slug}:
 *   get:
 *     summary: Get blog by slug
 *     tags: [Blog]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Blog retrieved successfully
 *       404:
 *         description: Blog not found
 */
router.get('/:slug', blogSlugValidation, validateRequest, async (req, res, next) => {
  try {
    const blog = await Blog.findOne({ 
      slug: req.params.slug, 
      isPublished: true, 
      isDeleted: false 
    }).populate('author', 'name email');

    if (!blog) {
      return res.status(404).json({
        success: false,
        message: 'Blog post not found or not published'
      });
    }

    // Increment views
    blog.views += 1;
    await blog.save();

    res.json({
      success: true,
      message: 'Blog retrieved successfully',
      data: { blog }
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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - slug
 *               - content
 *               - excerpt
 *             properties:
 *               title:
 *                 type: string
 *               slug:
 *                 type: string
 *               content:
 *                 type: string
 *               excerpt:
 *                 type: string
 *               featuredImage:
 *                 type: string
 *               categories:
 *                 type: array
 *                 items:
 *                   type: string
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *               isPublished:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Blog created successfully
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
router.post('/', authenticate, createBlogValidation, validateRequest, sanitizeInput, async (req, res, next) => {
  try {
    const blogData = {
      ...req.body,
      author: req.admin._id
    };

    const blog = new Blog(blogData);
    await blog.save();
    await blog.populate('author', 'name email');

    logger.info('Blog created', { 
      blogId: blog._id, 
      title: blog.title,
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
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               slug:
 *                 type: string
 *               content:
 *                 type: string
 *               excerpt:
 *                 type: string
 *               featuredImage:
 *                 type: string
 *               categories:
 *                 type: array
 *                 items:
 *                   type: string
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *               isPublished:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Blog updated successfully
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Blog not found
 */
router.put('/:id', authenticate, updateBlogValidation, validateRequest, sanitizeInput, async (req, res, next) => {
  try {
    const blog = await Blog.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      req.body,
      { new: true, runValidators: true }
    ).populate('author', 'name email');

    if (!blog) {
      return res.status(404).json({
        success: false,
        message: 'Blog not found'
      });
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
 * /api/blogs/{id}:
 *   delete:
 *     summary: Delete blog (Admin only)
 *     tags: [Blog]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Blog deleted successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Blog not found
 */
router.delete('/:id', authenticate, blogIdValidation, validateRequest, async (req, res, next) => {
  try {
    const blog = await Blog.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true }
    );

    if (!blog) {
      return res.status(404).json({
        success: false,
        message: 'Blog not found'
      });
    }

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

export default router;