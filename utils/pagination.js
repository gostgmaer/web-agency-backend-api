/**
 * Pagination utility functions
 */

/**
 * Get pagination parameters from request query
 * @param {Object} req - Express request object
 * @returns {Object} - { page, limit, skip }
 */
export const getPaginationParams = (req) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const skip = (page - 1) * limit;

  return { page, limit, skip };
};

/**
 * Generate pagination metadata for response
 * @param {number} total - Total number of documents
 * @param {number} page - Current page
 * @param {number} limit - Items per page
 * @returns {Object} - Pagination metadata
 */
export const getPaginationMeta = (total, page, limit) => {
  const totalPages = Math.ceil(total / limit);

  return {
    currentPage: page,
    totalPages,
    totalItems: total,
    itemsPerPage: limit,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
    nextPage: page < totalPages ? page + 1 : null,
    prevPage: page > 1 ? page - 1 : null
  };
};

/**
 * Create paginated query helper
 * @param {Object} model - Mongoose model
 * @param {Object} filter - Query filter
 * @param {Object} options - { page, limit, sort, populate, select }
 * @returns {Object} - { data, pagination }
 */
export const paginate = async (model, filter = {}, options = {}) => {
  const page = Math.max(1, options.page || 1);
  const limit = Math.min(100, Math.max(1, options.limit || 10));
  const skip = (page - 1) * limit;
  const sort = options.sort || { createdAt: -1 };

  const [data, total] = await Promise.all([
    model.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate(options.populate || '')
      .select(options.select || '')
      .lean(),
    model.countDocuments(filter)
  ]);

  return {
    data,
    pagination: getPaginationMeta(total, page, limit)
  };
};

export default {
  getPaginationParams,
  getPaginationMeta,
  paginate
};