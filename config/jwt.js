// Shared secret — must match JWT_ACCESS_SECRET in the user-auth-service.
// Tokens are issued exclusively by the user-auth-service; this service only verifies them.
export const JWT_SECRET = process.env.JWT_ACCESS_SECRET;
export const JWT_ISSUER = process.env.JWT_ISSUER || 'user-auth-service';
export const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'dashboard-app';