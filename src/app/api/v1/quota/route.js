import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { USAGE_APIKEY_PROVIDERS, resolveProviderId } from "@/shared/constants/providers";
import { getConnectionUsage } from "@/shared/services/providerUsage.js";
import { allowedProvidersForKey, filterReportForProviders, getQuotaReport } from "@/shared/services/quotaReport.js";
import { getKeyAccessContext } from "@/sse/services/keyAccess.js";
import { getComboModels, getModelInfo } from "@/sse/services/model.js";

export const dynamic = "force-dynamic";

const deps = {
  loadConnections: getProviderConnections,
  apikeyProviders: USAGE_APIKEY_PROVIDERS,
  // Cached read only: no forced provider call and no credential refresh, so a
  // key holder cannot hammer the provider or rotate an account's OAuth tokens.
  fetchUsage: async (connection) => (await getConnectionUsage(connection, { force: false, refresh: false })).usage,
};

/**
 * GET /v1/quota - remaining allowance per account and window (5h session,
 * weekly, per-model weekly) plus quota guard state. Authenticated by the same
 * API key as /v1/messages (src/dashboardGuard.js); a restricted key sees only
 * the providers its combos and models reach.
 */
export async function GET(request) {
  try {
    const result = await getQuotaReport(deps);
    const access = await getKeyAccessContext(request);
    const providers = access
      ? await allowedProvidersForKey(access.allow, { getComboModels, getModelInfo, resolveProviderId })
      : null;
    return Response.json(filterReportForProviders(result, providers), { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.warn("[Quota] Could not build the quota report");
    return Response.json({ error: { message: "Quota report unavailable" } }, { status: 500 });
  }
}
