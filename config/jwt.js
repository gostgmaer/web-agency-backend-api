import 'dotenv/config';

function getRequiredAnyEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) {
      return String(value).trim();
    }
  }
  throw new Error(`${names.join(' or ')} environment variable is required`);
}

// IAM uses RS256 asymmetric signing when JWT_PUBLIC_KEY is configured.
// Downstream services verify with the RSA public key only — never with the private key.
// Falls back to HS256 shared secret (JWT_SECRET) when no public key is present.
function resolveJwtPublicKey() {
  const b64 = process.env.JWT_PUBLIC_KEY;
  if (!b64) return null;
  return Buffer.from(b64, 'base64').toString('utf8');
}

function resolveJwtVerificationKey() {
  const publicKey = resolveJwtPublicKey();
  if (publicKey) return publicKey;
  return getRequiredAnyEnv('JWT_SECRET', 'JWT_ACCESS_SECRET');
}

export const JWT_SECRET = resolveJwtVerificationKey();
export const JWT_ALGORITHM = resolveJwtPublicKey() ? 'RS256' : 'HS256';
export const JWT_ISSUER = getRequiredAnyEnv('JWT_ISSUER');
export const JWT_AUDIENCE = getRequiredAnyEnv('JWT_AUDIENCE');

// Portal product session cookies (ea_comm_session, ja_session, …) are signed
// with RS256 or HS256 depending on the configuration. We verify using
// resolveJwtVerificationKey() which returns the public key when configured.
export const PORTAL_SESSION_SECRET = resolveJwtVerificationKey();