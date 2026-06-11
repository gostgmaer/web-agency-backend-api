/**
 * HMAC-SHA256 request signing for the multi-tenant AI workflow agent.
 *
 * The AI agent verifies requests using this canonical format:
 *   METHOD\nPATH\nTIMESTAMP\nSHA256_HEX(BODY)
 *
 * Signature: v1=<base64url(hmac-sha256(secret, canonical))>
 *
 * Reference: multi-tennet-ai-agent/app/security/signing.py
 */

import crypto from 'crypto';

/**
 * Compute the HMAC-SHA256 signing headers for a request to the AI workflow agent.
 *
 * @param {object} options
 * @param {string} options.method   - HTTP method (GET, POST, etc.)
 * @param {string} options.path     - Request path WITH query string, e.g. /v1/analytics/tenant-overview?start_date=...
 * @param {string|Buffer} [options.body] - Request body (empty string for GET requests)
 * @param {string} options.secret   - Shared signing secret
 * @param {string} [options.keyVersion] - Key version (default: "v1")
 * @returns {object|null} Headers object with x-signature-key-version, x-signature-timestamp, x-signature, or null if no secret.
 */
export function signAiWorkflowRequest({ method, path, body = '', secret, keyVersion = 'v1' }) {
  if (!secret) return null;

  const timestamp = new Date().toISOString();
  const bodyBytes = typeof body === 'string' ? body : body.toString('utf-8');
  const bodyHash = crypto.createHash('sha256').update(bodyBytes).digest('hex');

  const canonical = [
    String(method).toUpperCase(),
    path,
    timestamp,
    bodyHash,
  ].join('\n');

  const digest = crypto
    .createHmac('sha256', secret)
    .update(canonical)
    .digest();

  const sig = `v1=${Buffer.from(digest).toString('base64url').replace(/=+$/, '')}`;

  return {
    'x-signature-key-version': keyVersion,
    'x-signature-timestamp': timestamp,
    'x-signature': sig,
  };
}
