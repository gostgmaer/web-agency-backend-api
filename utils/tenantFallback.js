let runtimeFallbackTenantId = null;
let runtimeFallbackTenantSlug = null;

export function setRuntimeTenantFallback({ tenantId, tenantSlug } = {}) {
  runtimeFallbackTenantId = tenantId ? String(tenantId).trim() : null;
  runtimeFallbackTenantSlug = tenantSlug ? String(tenantSlug).trim() : null;
}

export function getRuntimeTenantFallback() {
  return {
    tenantId: runtimeFallbackTenantId || null,
    tenantSlug: runtimeFallbackTenantSlug || null,
  };
}
