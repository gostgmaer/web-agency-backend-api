/**
 * Lead activity logger middleware factory.
 */
import logger from '../utils/logger.js';

export function leadActivityLogger(options = {}) {
  const {
    excludeRoutes = ['/health', '/favicon.ico'],
    excludeMethods = ['OPTIONS', 'HEAD'],
    skipSuccessfulGET = false,
  } = options;

  return (req, res, next) => {
    if (excludeRoutes.some((r) => req.path.includes(r))) return next();
    if (excludeMethods.includes(req.method)) return next();
    if (skipSuccessfulGET && req.method === 'GET') return next();

    const startTime = Date.now();
    const originalEnd = res.end;

    res.end = function (chunk, encoding) {
      const ms = Date.now() - startTime;
      const userId = req.user?.id || 'anonymous';
      logger.info(`[lead-activity] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms user=${userId}`);
      originalEnd.call(this, chunk, encoding);
    };

    next();
  };
}
