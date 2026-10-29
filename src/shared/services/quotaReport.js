// Read-only quota report for API-key holders (GET /v1/quota). It shows what each
// account has left per window without dashboard access, so it never refreshes
// OAuth credentials, never forces a provider read and never returns emails,
// tokens or provider error text.
import { CLAUDE_MODEL_WINDOW, quotaRemainingPercent } from "./quotaGuard.js";

// One provider read per account per minute however many keys poll this.
export const QUOTA_REPORT_TTL_MS = 60_000;
const READ_TIMEOUT_MS = 15_000;

const report = globalThis.__quotaReport ??= { result: null, expiresAt: 0, promise: null };

// "felipe@example.com" -> "fe***@example.com": enough to recognise your own account.
export function maskEmail(value) {
  if (typeof value !== "string") return value ?? null;
  return value.replace(/([\w.+-]{1,2})[\w.+-]*@([\w.-]+)/g, "$1***@$2");
}

function usageSupported(connection, apikeyProviders) {
  if (connection.authType === "oauth") return true;
  const isApikey = connection.authType === "apikey" || connection.authType === "api_key";
  return isApikey && apikeyProviders.includes(connection.provider);
}

async function withTimeout(work) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Quota read timed out")), READ_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

function toWindows(connection, usage) {
  return Object.entries(usage?.quotas || {}).flatMap(([name, quota]) => {
    const remainingPercent = quotaRemainingPercent(quota);
    if (remainingPercent === null) return [];
    const resetMs = Date.parse(quota.resetAt);
    const model = connection.provider === "claude" ? CLAUDE_MODEL_WINDOW.exec(name)?.[1] || null : null;
    return [{
      name,
      model,
      usedPercent: Math.round((100 - remainingPercent) * 10) / 10,
      remainingPercent: Math.round(remainingPercent * 10) / 10,
      resetAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
    }];
  });
}

function guardSummary(connection) {
  const guard = connection.quotaGuard;
  if (!guard?.enabled) return { enabled: false };
  const state = connection.quotaGuardState || {};
  return {
    enabled: true,
    thresholdPercent: guard.thresholdPercent,
    paused: state.paused === true,
    pausedModels: Array.isArray(state.pausedModels) ? state.pausedModels : [],
    override: state.override === true,
  };
}

// The quota guard monitor's last reading, for when the live read fails.
function guardWindows(connection) {
  const state = connection.quotaGuardState || {};
  const entries = [...Object.entries(state.windows || {}), ...Object.entries(state.modelWindows || {})];
  return entries.flatMap(([name, window]) => {
    const remainingPercent = quotaRemainingPercent({ remainingPercentage: window?.remainingPercent });
    if (remainingPercent === null) return [];
    return [{
      name,
      model: window.family || null,
      usedPercent: Math.round((100 - remainingPercent) * 10) / 10,
      remainingPercent: Math.round(remainingPercent * 10) / 10,
      resetAt: window.resetAt || null,
    }];
  });
}

async function readAccount(connection, deps) {
  const account = {
    id: connection.id,
    provider: connection.provider,
    name: maskEmail(connection.name || connection.displayName || connection.email || connection.id),
    active: connection.isActive !== false,
    guard: guardSummary(connection),
    windows: [],
  };
  try {
    const usage = await withTimeout(deps.fetchUsage(connection));
    account.windows = toWindows(connection, usage);
    if (usage?.stale) account.stale = true;
    if (!account.windows.length) account.error = "Quota not reported by the provider";
  } catch {
    account.error = "Quota unavailable right now";
  }
  if (account.error) {
    const fallback = guardWindows(connection);
    if (fallback.length) {
      account.windows = fallback;
      account.stale = true;
      account.checkedAt = connection.quotaGuardState.checkedAt || null;
      delete account.error;
    }
  }
  return account;
}

export async function buildQuotaReport(deps) {
  const connections = (await deps.loadConnections())
    .filter((connection) => usageSupported(connection, deps.apikeyProviders));
  const accounts = await Promise.all(connections.map((connection) => readAccount(connection, deps)));
  return { object: "quota", checkedAt: new Date(deps.now?.() ?? Date.now()).toISOString(), accounts };
}

export async function getQuotaReport(deps, state = report) {
  const now = deps.now?.() ?? Date.now();
  if (state.result && state.expiresAt > now) return state.result;
  if (state.promise) return state.promise;
  state.promise = buildQuotaReport(deps).then((result) => {
    state.result = result;
    state.expiresAt = (deps.now?.() ?? Date.now()) + QUOTA_REPORT_TTL_MS;
    return result;
  }).finally(() => { state.promise = null; });
  return state.promise;
}

// Providers a restricted key can reach: its listed models, plus every member of
// its listed combos (nested combos included).
export async function allowedProvidersForKey(allow, { getComboModels, getModelInfo, resolveProviderId }) {
  const providers = new Set();
  const seen = new Set();
  const visit = async (entry, depth) => {
    if (typeof entry !== "string" || !entry || seen.has(entry) || depth > 4) return;
    seen.add(entry);
    const members = await getComboModels(entry);
    if (members) {
      for (const member of members) await visit(typeof member === "string" ? member : member?.model, depth + 1);
      return;
    }
    const info = await getModelInfo(entry);
    if (info?.provider) providers.add(String(info.provider).toLowerCase());
    if (!entry.includes("/")) providers.add(String(resolveProviderId(entry)).toLowerCase());
  };
  for (const entry of allow) await visit(entry, 0);
  return providers;
}

export function filterReportForProviders(result, providers) {
  if (!providers) return result;
  return { ...result, accounts: result.accounts.filter((account) => providers.has(String(account.provider).toLowerCase())) };
}
