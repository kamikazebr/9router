// Shared by the server monitor and both account toolbars. No credentials here.
export const DEFAULT_QUOTA_GUARD = { enabled: false, thresholdPercent: 50 };
export const QUOTA_GUARD_INTERVAL_MS = 60_000;

export function normalizeQuotaGuard(value) {
  if (!value || typeof value.enabled !== "boolean"
    || typeof value.thresholdPercent !== "number" || !Number.isFinite(value.thresholdPercent)
    || value.thresholdPercent < 0 || value.thresholdPercent >= 100) {
    throw new Error("Quota guard requires enabled and a remaining percentage from 0 to less than 100");
  }
  return { enabled: value.enabled, thresholdPercent: value.thresholdPercent };
}

// Remaining share of a provider quota window, 0-100, or null when unknown/unlimited.
export function quotaRemainingPercent(quota) {
  if (!quota || quota.unlimited === true) return null;
  let result = quota.remainingPercentage;
  if (result == null && typeof quota.total === "number" && quota.total > 0) {
    if (typeof quota.remaining === "number") result = quota.remaining / quota.total * 100;
    else if (typeof quota.used === "number") result = (quota.total - quota.used) / quota.total * 100;
  }
  return typeof result === "number" && Number.isFinite(result) && result <= 100 ? Math.max(0, result) : null;
}

export function isQuotaGuardPaused(connection) {
  return connection.quotaGuard?.enabled === true && connection.quotaGuardState?.paused === true;
}

// Claude reports per-model weekly budgets ("weekly fable (7d)", "weekly opus (7d)")
// next to the account-wide session and weekly windows. Those pause only requests
// for that model family, so a drained Fable budget does not block Sonnet or Haiku.
const CLAUDE_ACCOUNT_WINDOWS = new Set(["session (5h)", "weekly (7d)"]);
export const CLAUDE_MODEL_WINDOW = /^weekly (.+) \(7d\)$/;

export function modelMatchesFamily(model, family) {
  if (!model || !family) return false;
  return String(model).toLowerCase().split(/[^a-z0-9]+/).includes(String(family).toLowerCase());
}

// Any automatic pause: the whole account or some model families.
export function hasQuotaGuardPause(connection) {
  return isQuotaGuardPaused(connection) || (connection.quotaGuard?.enabled === true
    && Array.isArray(connection.quotaGuardState?.pausedModels) && connection.quotaGuardState.pausedModels.length > 0);
}

export function isQuotaGuardModelPaused(connection, model) {
  if (connection.quotaGuard?.enabled !== true) return false;
  const families = connection.quotaGuardState?.pausedModels;
  return Array.isArray(families) && families.some((family) => modelMatchesFamily(model, family));
}

export function resumeQuotaGuard(state = {}, now = Date.now()) {
  const windows = { ...(state.windows || {}), ...(state.modelWindows || {}) };
  return { ...state, paused: false, pausedModels: [], override: true, overrideStartedAt: new Date(now).toISOString(),
    overrideResets: Object.fromEntries(Object.entries(windows).map(([key, window]) => [key, window.resetAt])) };
}

export function evaluateQuotaGuard(connection, usage, now = Date.now()) {
  const previous = connection.quotaGuardState || {};
  const checkedAt = new Date(now).toISOString();
  if (!connection.quotaGuard?.enabled) return { paused: false, override: false, checkedAt };

  const windows = {};
  const modelWindows = {};
  for (const [name, quota] of Object.entries(usage?.quotas || {})) {
    // These providers also report unrelated review/model budgets. Protect the
    // account's shared session/weekly allowance, not a separate product's quota.
    if (connection.provider === "codex" && !["session", "weekly"].includes(name)) continue;
    let family = null;
    if (connection.provider === "claude" && !CLAUDE_ACCOUNT_WINDOWS.has(name)) {
      family = CLAUDE_MODEL_WINDOW.exec(name)?.[1] || null;
      if (!family) continue;
    }
    const remainingPercent = quotaRemainingPercent(quota);
    if (remainingPercent === null) continue;
    const resetMs = Date.parse(quota.resetAt);
    const entry = { remainingPercent, resetAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null };
    if (family) modelWindows[name] = { ...entry, family };
    else windows[name] = entry;
  }

  if (!Object.keys(windows).length || usage?.error || usage?.message || usage?.stale) {
    return { ...previous, checkedAt, error: "Quota monitoring unavailable or incomplete; previous state retained" };
  }

  // A window the provider stopped reporting after its last reset time has reset
  // (Claude can omit an idle 5h session). Treating it as missing would keep an
  // account paused forever, since a paused account starts no new window.
  for (const [name, window] of Object.entries(previous.windows || {})) {
    if (!windows[name] && window?.resetAt && Date.parse(window.resetAt) <= now) {
      windows[name] = { remainingPercent: 100, resetAt: null };
    }
  }

  const entries = Object.entries(windows);
  const incomplete = Object.keys(previous.windows || {}).some((name) => !windows[name]);
  const threshold = connection.quotaGuard.thresholdPercent;
  const remainingPercent = Math.min(...entries.map(([, window]) => window.remainingPercent));
  const belowThreshold = remainingPercent <= threshold;
  if (incomplete && !belowThreshold) {
    return { ...previous, checkedAt, error: "Quota monitoring incomplete; previous state retained" };
  }
  const lowModels = [...new Set(Object.values(modelWindows)
    .filter((window) => window.remainingPercent <= threshold).map((window) => window.family))];
  const resetConfirmed = Object.entries(previous.overrideResets || {}).some(([name, resetAt]) => {
    const current = windows[name] || modelWindows[name];
    return resetAt && Date.parse(resetAt) <= now && current?.resetAt && Date.parse(current.resetAt) > Date.parse(resetAt);
  });
  const override = previous.override === true && (belowThreshold || lowModels.length > 0) && !resetConfirmed;
  return {
    paused: belowThreshold && !override, override, checkedAt, remainingPercent,
    windows: incomplete ? { ...previous.windows, ...windows } : windows,
    modelWindows, pausedModels: override ? [] : lowModels,
    ...(incomplete ? { error: "Quota monitoring incomplete" } : {}),
    ...(override ? { overrideResets: previous.overrideResets, overrideStartedAt: previous.overrideStartedAt } : {}),
  };
}
