import 'dotenv/config';

// IAM uses RS256 asymmetric signing when JWT_PRIVATE_KEY / JWT_PUBLIC_KEY are configured.
// Downstream services verify with the RSA public key only — never with the private key.
// Falls back to HS256 shared secret (JWT_ACCESS_SECRET) when JWT_PUBLIC_KEY is absent.
function resolveJwtVerificationKey() {
  const b64 = process.env.JWT_PUBLIC_KEY;
  if (b64) return Buffer.from(b64, 'base64').toString('utf8');
  return process.env.JWT_ACCESS_SECRET;
}

export const JWT_SECRET = resolveJwtVerificationKey();
export const JWT_ALGORITHM = process.env.JWT_PUBLIC_KEY ? 'RS256' : 'HS256';
export const JWT_ISSUER = process.env.JWT_ISSUER || 'user-auth-service';
export const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'dashboard-app';