/**
 * Standard API response helpers for lead routes.
 * Matches the shape { success, message, data } used throughout the service.
 */

export const HTTP_STATUS = {
  OK: 200, CREATED: 201, NO_CONTENT: 204,
  BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403,
  NOT_FOUND: 404, CONFLICT: 409, UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429, INTERNAL_SERVER_ERROR: 500, SERVICE_UNAVAILABLE: 503,
};

const serialize = (val) => {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'object') return val;
  if (val instanceof Date) return val;
  if (Buffer.isBuffer(val)) return val;
  if (Array.isArray(val)) return val.map(serialize);
  const src = typeof val.toJSON === 'function' ? val.toJSON() : val;
  if (typeof src !== 'object' || src === null) return src;
  const out = {};
  for (const key of Object.keys(src)) {
    if (key === '__v' || key === '_id' || key === 'id') continue;
    out[key] = serialize(src[key]);
  }
  const rawId = src.id !== undefined ? src.id : src._id;
  if (rawId !== undefined) out.id = String(rawId);
  return out;
};

export const sendSuccess = (res, { data = null, message = 'Success', statusCode = HTTP_STATUS.OK } = {}) => {
  const response = { success: true, message };
  if (data !== null && data !== undefined) response.data = serialize(data);
  return res.status(statusCode).json(response);
};

export const sendCreated = (res, { data = null, message = 'Created successfully' } = {}) =>
  sendSuccess(res, { data, message, statusCode: HTTP_STATUS.CREATED });

export const sendPaginated = (res, { docs, message = 'Success', page, pageSize, totalRecords, totalPages, hasNext, hasPrev } = {}) => {
  const response = { success: true, message };
  if (docs !== null && docs !== undefined) response.data = serialize(docs);
  response.pagination = { page, pageSize, totalRecords, totalPages, hasNext, hasPrev };
  return res.status(HTTP_STATUS.OK).json(response);
};

export const sendError = (res, { message = 'An error occurred', statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR, code = null, details = null, errors = null, hint = null } = {}) => {
  const err = {};
  if (code) err.code = code;
  if (details || errors) err.details = details || errors;
  if (hint) err.hint = hint;
  return res.status(statusCode).json({ success: false, message, error: err });
};

export const errorResponse = (res, message, statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR) =>
  sendError(res, { message, statusCode });
