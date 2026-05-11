import crypto from 'crypto';

function normalizePath(pathValue = '') {
  const value = String(pathValue || '').trim();
  if (!value) return '/';
  return value.startsWith('/') ? value : `/${value}`;
}

export function createGatewaySignature({
  method = 'GET',
  path = '/',
  tenantId = '',
  requestId = '',
  secret,
} = {}) {
  if (!secret) return null;

  const timestamp = Date.now().toString();
  const payload = [
    String(method || 'GET').toUpperCase(),
    normalizePath(path),
    String(tenantId || ''),
    String(requestId || ''),
    timestamp,
  ].join('|');

  const hmac = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return { hmac, timestamp };
}

export function addGatewaySignatureHeaders(
  headers = {},
  {
    method = 'GET',
    path = '/',
    tenantId = '',
    requestId = '',
    secret,
  } = {},
) {
  const signature = createGatewaySignature({ method, path, tenantId, requestId, secret });
  if (!signature) return headers;

  return {
    ...headers,
    'X-Gateway-HMAC': signature.hmac,
    'X-Gateway-Timestamp': signature.timestamp,
  };
}

export function getPathFromUrl(url) {
  if (!url) return '/';

  try {
    const parsed = new URL(url);
    return normalizePath(`${parsed.pathname}${parsed.search || ''}`);
  } catch {
    return normalizePath(url);
  }
}
