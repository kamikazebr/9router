// e2e for GET /v1/quota against a throwaway 9router container (no browser).
// temp data dir -> boot (migrations) -> stop -> seed accounts and API keys -> boot
// -> HTTP checks -> always cleanup. Anthropic hosts resolve to 127.0.0.1 inside the
// container, so the fake tokens never leave the machine and the live read fails,
// which exercises the fallback to the quota guard's last reading. See README.md.
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, chmodSync, rmSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const IMAGE = process.env.IMAGE
  || `9router:${execFileSync(join(REPO_ROOT, "scripts/fork/version.sh"), { encoding: "utf8" }).trim()}`;
const NAME = "9r-e2e-quota-api";
const PORT = Number(process.env.E2E_PORT || 20198);
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP = process.env.E2E_KEEP_DIR === "1";
const BLOCKED_HOSTS = ["api.anthropic.com", "claude.ai", "console.anthropic.com"];

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function check(name, fn) {
  try { await fn(); results.push([name, true]); console.log(`PASS  ${name}`); }
  catch (e) { results.push([name, false]); console.log(`FAIL  ${name}\n      ${String(e.message).split("\n").slice(0, 4).join("\n      ")}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function startContainer(dataDir) {
  sh("docker", ["rm", "-f", NAME]);
  const r = sh("docker", ["run", "-d", "--rm", "--name", NAME, "-p", `127.0.0.1:${PORT}:20128`,
    ...BLOCKED_HOSTS.flatMap((h) => ["--add-host", `${h}:127.0.0.1`]),
    "-v", `${dataDir}:/app/data`, "-e", "REQUIRE_API_KEY=true", "-e", "STRICT_SSL=true",
    "-e", `INITIAL_PASSWORD=${randomBytes(12).toString("hex")}`, "-e", "DISABLE_BACKGROUND_TOKEN_REFRESH=true", IMAGE]);
  if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr}`);
}
async function waitReady(timeoutMs = 120000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await sleep(1000);
  }
  throw new Error("container not ready: " + sh("docker", ["logs", "--tail", "30", NAME]).stdout);
}
function stopContainer() { sh("docker", ["stop", "-t", "5", NAME]); }

const KEYS = {
  open: `sk-e2e-open-${randomBytes(8).toString("hex")}`,
  claudeOnly: `sk-e2e-claude-${randomBytes(8).toString("hex")}`,
  codexOnly: `sk-e2e-codex-${randomBytes(8).toString("hex")}`,
  disabled: `sk-e2e-off-${randomBytes(8).toString("hex")}`,
};

function seed(dataDir) {
  const dbPath = join(dataDir, "db", "data.sqlite");
  assert(existsSync(dbPath), `no sqlite at ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  const now = new Date().toISOString();
  const future = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  const base = { accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: "2099-01-01T00:00:00.000Z", testStatus: "active" };
  const conns = [
    { id: "e2e-owner-a", name: "owner.a@example.test", priority: 1, isActive: 1, data: { ...base,
      quotaGuard: { enabled: true, thresholdPercent: 20 },
      quotaGuardState: { paused: false, pausedModels: ["fable"], checkedAt: now,
        windows: { "session (5h)": { remainingPercent: 92, resetAt: future(3) }, "weekly (7d)": { remainingPercent: 30, resetAt: future(72) } },
        modelWindows: { "weekly fable (7d)": { remainingPercent: 10, resetAt: future(72), family: "fable" } } } } },
    { id: "e2e-owner-b", name: "Owner B", priority: 2, isActive: 1, data: { ...base,
      quotaGuard: { enabled: true, thresholdPercent: 20 },
      quotaGuardState: { paused: true, remainingPercent: 5, pausedModels: [], checkedAt: now,
        windows: { "session (5h)": { remainingPercent: 5, resetAt: future(3) }, "weekly (7d)": { remainingPercent: 70, resetAt: future(72) } } } } },
    { id: "e2e-owner-c", name: "Owner C", priority: 3, isActive: 0, data: { ...base } },
  ];
  const insConn = db.prepare(`INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  for (const c of conns) insConn.run(c.id, "claude", "oauth", c.name, `${c.id}@example.test`, c.priority, c.isActive, JSON.stringify(c.data), now, now);
  const insKey = db.prepare(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow) VALUES(?,?,?,?,?,?,?,?)`);
  insKey.run("e2e-key-open", KEYS.open, "open", null, 1, now, 0, "[]");
  insKey.run("e2e-key-claude", KEYS.claudeOnly, "claude only", null, 1, now, 1, JSON.stringify(["cc/claude-opus-5-5"]));
  insKey.run("e2e-key-codex", KEYS.codexOnly, "codex only", null, 1, now, 1, JSON.stringify(["cx/gpt-5"]));
  insKey.run("e2e-key-off", KEYS.disabled, "disabled", null, 0, now, 0, "[]");
  db.close();
}

const quota = (key) => fetch(`${BASE}/v1/quota`, key ? { headers: { Authorization: `Bearer ${key}` } } : {});

const dataDir = mkdtempSync(join(process.env.E2E_TMPDIR || tmpdir(), "9r-e2e-quota-"));
chmodSync(dataDir, 0o777);
try {
  console.log(`data dir: ${dataDir}  image: ${IMAGE}`);
  startContainer(dataDir); await waitReady(); await sleep(3000); stopContainer();
  for (let i = 0; i < 20 && sh("docker", ["ps", "-q", "-f", `name=${NAME}`]).stdout.trim(); i++) await sleep(500);
  sh("chmod", ["-R", "a+rwX", dataDir]);
  seed(dataDir);
  sh("chmod", ["-R", "a+rwX", dataDir]);
  startContainer(dataDir); await waitReady();

  await check("no key -> 401", async () => { const r = await quota(); assert(r.status === 401, `got ${r.status}`); });
  await check("disabled key -> 401", async () => { const r = await quota(KEYS.disabled); assert(r.status === 401, `got ${r.status}`); });

  let body, text;
  await check("open key -> 200 with every Claude account", async () => {
    const r = await quota(KEYS.open);
    text = await r.text();
    assert(r.status === 200, `got ${r.status}: ${text.slice(0, 200)}`);
    body = JSON.parse(text);
    assert(body.object === "quota", "object");
    const ids = body.accounts.map((a) => a.id).sort().join(",");
    assert(ids === "e2e-owner-a,e2e-owner-b,e2e-owner-c", `accounts: ${ids}`);
  });
  await check("no tokens or emails in the response", async () => {
    assert(!/fake-access|fake-refresh|owner\.a@|e2e-owner-[abc]@/.test(text), text.slice(0, 400));
    const a = body.accounts.find((x) => x.id === "e2e-owner-a");
    assert(a.name === "ow***@example.test", `name ${a.name}`);
  });
  await check("failed live read falls back to the guard's last reading", async () => {
    const a = body.accounts.find((x) => x.id === "e2e-owner-a");
    assert(a.stale === true && a.checkedAt, `stale ${a.stale} checkedAt ${a.checkedAt}`);
    const byName = Object.fromEntries(a.windows.map((w) => [w.name, w]));
    assert(byName["session (5h)"]?.remainingPercent === 92 && byName["session (5h)"].usedPercent === 8, JSON.stringify(byName["session (5h)"]));
    assert(byName["weekly fable (7d)"]?.model === "fable" && byName["weekly fable (7d)"].remainingPercent === 10, JSON.stringify(byName["weekly fable (7d)"]));
    assert(a.guard.enabled && a.guard.thresholdPercent === 20 && a.guard.pausedModels.includes("fable"), JSON.stringify(a.guard));
  });
  await check("paused account reports paused; account without a reading reports an error", async () => {
    const b = body.accounts.find((x) => x.id === "e2e-owner-b");
    assert(b.guard.paused === true, JSON.stringify(b.guard));
    const c = body.accounts.find((x) => x.id === "e2e-owner-c");
    assert(c.active === false && c.windows.length === 0 && typeof c.error === "string", JSON.stringify(c));
  });
  await check("key restricted to a Claude model sees the Claude accounts", async () => {
    const r = await quota(KEYS.claudeOnly);
    const ids = (await r.json()).accounts.map((a) => a.id);
    assert(r.status === 200 && ids.length === 3, `status ${r.status} ids ${ids}`);
  });
  await check("key restricted to Codex sees no Claude account", async () => {
    const r = await quota(KEYS.codexOnly);
    const ids = (await r.json()).accounts.map((a) => a.id);
    assert(r.status === 200 && ids.length === 0, `status ${r.status} ids ${ids}`);
  });
  await check("x-api-key header works too", async () => {
    const r = await fetch(`${BASE}/v1/quota`, { headers: { "x-api-key": KEYS.open } });
    assert(r.status === 200, `got ${r.status}`);
  });
} catch (e) {
  results.push(["setup", false]); console.log(`FAIL  setup\n      ${e.message}`);
} finally {
  stopContainer();
  if (!KEEP) rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
