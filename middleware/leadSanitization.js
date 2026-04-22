/**
 * Input sanitization middleware for lead routes.
 * Strips HTML and script-injection patterns from req.body, req.query, req.params.
 */

const sanitizeString = (input) => {
  if (typeof input !== 'string') return input;
  return input.trim().replace(/[<>]/g, '').replace(/javascript:/gi, '').replace(/on\w+\s*=/gi, '');
};

const sanitizeObject = (obj) => {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitizeString(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  if (typeof obj === 'object') {
    const sanitized = {};
    for (const key of Object.keys(obj)) sanitized[key] = sanitizeObject(obj[key]);
    return sanitized;
  }
  return obj;
};

export const sanitizeInput = (req, _res, next) => {
  if (req.body && typeof req.body === 'object') req.body = sanitizeObject(req.body);
  if (req.query && typeof req.query === 'object') req.query = sanitizeObject(req.query);
  if (req.params && typeof req.params === 'object') req.params = sanitizeObject(req.params);
  next();
};

export { sanitizeObject };
