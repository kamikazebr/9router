import { evaluateQuotaGuard, QUOTA_GUARD_INTERVAL_MS } from "./quotaGuard.js";

// One timer per server process, including Next.js development hot reloads.
const monitor = globalThis.__quotaGuardMonitor ??= { interval: null, running: false, checking: new Map() };

async function defaultDeps() {
  const [db, usage] = await Promise.all([
    import("@/lib/db/repos/connectionsRepo.js"),
    import("./providerUsage.js"),
  ]);
  return {
    loadConnections: db.getProviderConnections,
    readConnection: db.getProviderConnectionById,
    saveState: db.updateProviderQuotaGuardState,
    // Periodic checks are read-only: token rotation stays with the request path
    // and the background refresher. Only a manual "check now" may refresh.
    fetchUsage: async (connection, force = false) => (await usage.getConnectionUsage(connection, { force, refresh: force })).usage,
  };
}

async function withTimeout(work) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Quota check timed out")), 30_000);
    })]);
  } finally { clearTimeout(timer); }
}

export async function checkConnectionQuota(connection, deps, force = false) {
  let state;
  try {
    const usage = await withTimeout(deps.fetchUsage(connection, force));
    state = evaluateQuotaGuard(connection, usage);
  } catch {
    // Never persist provider error text: it may contain credentials or URLs.
    state = { ...connection.quotaGuardState, checkedAt: new Date().toISOString(), error: "Quota check failed; previous state retained" };
  }
  return deps.saveState(connection, state);
}

export async function runQuotaGuardTick(deps, state = monitor) {
  if (state.running) return;
  state.running = true;
  state.checking ??= new Map();
  try {
    deps ??= await defaultDeps();
    const connections = await deps.loadConnections();
    // ponytail: one read per opted-in account; add per-provider queues if large pools trigger 429s.
    await Promise.all(connections.map(async (connection) => {
      if (!connection.quotaGuard?.enabled || connection.isActive === false || state.checking.has(connection.id)) return;
      const check = checkConnectionQuota(connection, deps);
      state.checking.set(connection.id, check);
      try { await check; }
      catch { console.warn("[QuotaGuard] Could not save quota state"); }
      finally { state.checking.delete(connection.id); }
    }));
  } catch { console.warn("[QuotaGuard] Monitor tick failed; retrying next minute"); }
  finally { state.running = false; }
}

export async function checkQuotaGuardNow(id) {
  const deps = await defaultDeps();
  const connection = await deps.readConnection(id);
  if (!connection) return null;
  if (monitor.checking.has(id)) {
    await monitor.checking.get(id);
    return deps.readConnection(id);
  }
  const check = checkConnectionQuota(connection, deps, true);
  monitor.checking.set(id, check);
  try { return await check || await deps.readConnection(id); }
  finally { monitor.checking.delete(id); }
}

export function startQuotaGuardMonitor() {
  if (monitor.interval || process.env.NEXT_PHASE === "phase-production-build") return;
  void runQuotaGuardTick();
  monitor.interval = setInterval(() => { void runQuotaGuardTick(); }, QUOTA_GUARD_INTERVAL_MS);
  monitor.interval.unref?.();
}

export function stopQuotaGuardMonitor() {
  clearInterval(monitor.interval);
  monitor.interval = null;
}
