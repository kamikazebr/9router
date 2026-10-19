// Headless e2e for the 9router "Quota guard" dashboard UI.
// Self-contained: temp data dir -> boot container (migrations) -> stop -> seed SQLite
// -> boot again -> Playwright checks -> always cleanup. See README.md.
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, chmodSync, rmSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
// Default: the image scripts/fork/build-image.sh builds for HEAD.
const IMAGE = process.env.IMAGE
  || `9router:${execFileSync(join(REPO_ROOT, "scripts/fork/version.sh"), { encoding: "utf8" }).trim()}`;
const NAME = "9r-e2e";
const PORT = Number(process.env.E2E_PORT || 20197);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS_DIR || join(dirname(fileURLToPath(import.meta.url)), "../../../9router-patches/e2e-screenshots");
const PASSWORD = randomBytes(12).toString("hex");
const KEEP = process.env.E2E_KEEP_DIR === "1";

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
// opts.knownBug: the check documents a real product bug. It is reported as XFAIL and
// does not fail the run; if it starts passing it is reported XPASS (remove the flag).
async function check(name, fn, opts = {}) {
  try {
    await fn();
    results.push([name, true]); console.log(opts.knownBug ? `XPASS ${name} (known bug appears fixed; drop knownBug)` : `PASS  ${name}`);
  } catch (e) {
    const msg = String(e.message).split("\n").slice(0, 4).join("\n      ");
    if (opts.knownBug) { results.push([name, true, e]); console.log(`XFAIL ${name}\n      known bug: ${opts.knownBug}\n      ${msg}`); }
    else { results.push([name, false, e]); console.log(`FAIL  ${name}\n      ${msg}`); }
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function startContainer(dataDir) {
  sh("docker", ["rm", "-f", NAME]);
  const r = sh("docker", ["run", "-d", "--rm", "--name", NAME, "-p", `127.0.0.1:${PORT}:20128`,
    "-v", `${dataDir}:/app/data`, "-e", "REQUIRE_API_KEY=true", "-e", "STRICT_SSL=true",
    "-e", `INITIAL_PASSWORD=${PASSWORD}`, "-e", "DISABLE_BACKGROUND_TOKEN_REFRESH=true", IMAGE]);
  if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr}`);
}
async function waitReady(timeoutMs = 120000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await fetch(`${BASE}/login`); if (r.status < 500) return; } catch {}
    await sleep(1000);
  }
  throw new Error("container not ready: " + sh("docker", ["logs", "--tail", "30", NAME]).stdout);
}
function stopContainer() { sh("docker", ["stop", "-t", "5", NAME]); }

function seed(dataDir) {
  const dbPath = join(dataDir, "db", "data.sqlite");
  assert(existsSync(dbPath), `no sqlite at ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  const now = new Date().toISOString();
  const future = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  const base = { accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: "2099-01-01T00:00:00.000Z", testStatus: "active" };
  const conns = [
    { id: "e2e-owner-a", name: "Owner A", priority: 1, isActive: 1, data: { ...base,
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
  const ins = db.prepare(`INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  for (const c of conns) ins.run(c.id, "claude", "oauth", c.name, `${c.id}@example.test`, c.priority, c.isActive, JSON.stringify(c.data), now, now);
  db.close();
  return conns;
}

const dataDir = mkdtempSync(join(process.env.E2E_TMPDIR || tmpdir(), "9r-e2e-"));
chmodSync(dataDir, 0o777);
let browser;
try {
  console.log(`data dir: ${dataDir}  image: ${IMAGE}`);
  startContainer(dataDir); await waitReady(); await sleep(3000); stopContainer();
  for (let i = 0; i < 20 && sh("docker", ["ps", "-q", "-f", `name=${NAME}`]).stdout.trim(); i++) await sleep(500);
  sh("chmod", ["-R", "a+rwX", dataDir]);
  seed(dataDir);
  sh("chmod", ["-R", "a+rwX", dataDir]);
  startContainer(dataDir); await waitReady();

  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`${BASE}/login`);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard/, { timeout: 30000 });

  const api = async (id) => { const r = await ctx.request.get(`${BASE}/api/providers/${id}`); assert(r.ok(), `GET ${id} -> ${r.status()}`); return (await r.json()).connection; };
  const rowOf = (name) => page.locator("div.group").filter({ has: page.locator('button[aria-label="Configure quota guard"]') }).filter({ hasText: name }).last();
  const gotoProvider = async () => { await page.goto(`${BASE}/dashboard/providers/claude`); await rowOf("Owner A").waitFor({ timeout: 30000 }); };
  const openDialog = async (name) => { await rowOf(name).locator('button[aria-label="Configure quota guard"]').click(); const d = page.locator("div.fixed.inset-0.z-50").filter({ hasText: "Quota guard" }).last(); await d.waitFor(); return d; };

  await gotoProvider();
  await sleep(1500);

  await check("Owner B: auto-paused label, toggle ON, amber shield", async () => {
    const row = rowOf("Owner B");
    await row.getByText("auto-paused", { exact: true }).waitFor({ timeout: 5000 });
    assert((await row.getByRole("switch").first().getAttribute("aria-checked")) === "true", "toggle not checked");
    const cls = await row.locator('button[aria-label="Configure quota guard"]').getAttribute("class");
    assert(/text-amber-500/.test(cls), `shield not amber: ${cls}`);
  });

  await check("Owner C: toggle OFF, status disabled", async () => {
    const row = rowOf("Owner C");
    assert((await row.getByRole("switch").first().getAttribute("aria-checked")) === "false", "toggle not off");
    await row.getByText("disabled", { exact: true }).waitFor({ timeout: 5000 });
  });

  await check("Owner A: amber shield + dialog shows model pause, windows, Resume now", async () => {
    const cls = await rowOf("Owner A").locator('button[aria-label="Configure quota guard"]').getAttribute("class");
    assert(/text-amber-500/.test(cls), `shield not amber: ${cls}`);
    await page.screenshot({ path: join(SHOTS, "providers-page.png"), fullPage: true });
    const d = await openDialog("Owner A");
    await d.getByText("Paused for fable models").waitFor({ timeout: 5000 });
    const li = d.locator("li", { hasText: "weekly fable (7d)" });
    const t = await li.innerText();
    assert(/weekly fable \(7d\): 10% remaining/.test(t) && /resets /.test(t), `fable line: ${t}`);
    await d.locator("li", { hasText: "session (5h): 92% remaining" }).waitFor();
    await d.locator("li", { hasText: "weekly (7d): 30% remaining" }).waitFor();
    await d.getByRole("button", { name: /Resume now/ }).waitFor();
    await page.screenshot({ path: join(SHOTS, "quota-guard-dialog-owner-a.png") });
    await d.getByRole("button", { name: "Cancel" }).click();
    await d.waitFor({ state: "detached" });
  });

  await check("Threshold: 100 shows validation error and disables Save; 25 persists", async () => {
    const d = await openDialog("Owner A");
    const input = d.getByLabel("Remaining allowance (%)");
    await input.fill("100");
    await d.getByText("Enter a percentage from 0 to less than 100").waitFor();
    assert(await d.getByRole("button", { name: "Save" }).isDisabled(), "Save not disabled for 100");
    await input.fill("25");
    const save = d.getByRole("button", { name: "Save" });
    assert(await save.isEnabled(), "Save disabled for 25");
    const [req] = await Promise.all([page.waitForRequest((r) => r.method() === "PUT" && r.url().endsWith("/api/providers/e2e-owner-a")), save.click()]);
    assert(/"thresholdPercent":25/.test(req.postData()), `body: ${req.postData()}`);
    await d.waitFor({ state: "detached" });
    const c = await api("e2e-owner-a");
    assert(c.quotaGuard?.thresholdPercent === 25, `stored: ${JSON.stringify(c.quotaGuard)}`);
  });

  await check("Normal toggle OFF then ON on Owner A does not clear pausedModels", async () => {
    await gotoProvider();
    const sw = rowOf("Owner A").getByRole("switch").first();
    assert((await sw.getAttribute("aria-checked")) === "true", "A not initially on");
    const off = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/providers/e2e-owner-a"));
    await sw.click(); await off;
    assert((await api("e2e-owner-a")).isActive === false, "A not deactivated");
    const on = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/providers/e2e-owner-a"));
    await sw.click(); await on;
    const c = await api("e2e-owner-a");
    assert(c.isActive === true, "A not reactivated");
    assert(JSON.stringify(c.quotaGuardState?.pausedModels) === '["fable"]', `pausedModels: ${JSON.stringify(c.quotaGuardState)}`);
    assert(c.quotaGuardState?.override !== true, "override was set by plain toggle");
  });

  await check("Quota Tracker: Owner B card has amber shield, toggle ON, not shown as disabled", async () => {
    await page.goto(`${BASE}/dashboard/quota`);
    const card = (name) => page.locator("div.rounded-xl, div.rounded-2xl, div").filter({ hasText: name }).filter({ has: page.locator('button[aria-label="Configure quota guard"]') }).last();
    await card("Owner B").waitFor({ timeout: 30000 });
    await sleep(1500);
    await page.screenshot({ path: join(SHOTS, "quota-tracker.png"), fullPage: true });
    const b = card("Owner B");
    assert((await b.getByText("disabled", { exact: true }).count()) === 0, "Owner B card shows disabled");
    assert(/text-amber-500/.test(await b.locator('button[aria-label="Configure quota guard"]').getAttribute("class")), "shield not amber");
    assert((await b.getByRole("switch").first().getAttribute("aria-checked")) === "true", "toggle not ON");
  });

  await check("Quota Tracker: guard badges for Owner B (auto-paused) and Owner A (paused: fable)", async () => {
    await page.goto(`${BASE}/dashboard/quota`);
    await page.getByText("Owner B").first().waitFor({ timeout: 30000 });
    await sleep(1500);
    const n = await page.getByText("auto-paused", { exact: true }).count();
    assert(n > 0, `no "auto-paused" text anywhere on the Quota Tracker (count=${n})`);
    const m = await page.getByText("paused: fable", { exact: true }).count();
    assert(m > 0, `no "paused: fable" badge on the Quota Tracker (count=${m})`);
  });

  await check("Owner B Resume now: PUT quotaGuardResume, 200, override set, no longer auto-paused", async () => {
    await gotoProvider();
    const d = await openDialog("Owner B");
    const [req, res] = await Promise.all([
      page.waitForRequest((r) => r.method() === "PUT" && r.url().endsWith("/api/providers/e2e-owner-b")),
      page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/providers/e2e-owner-b")),
      d.getByRole("button", { name: /Resume now/ }).click(),
    ]);
    assert(/"quotaGuardResume":true/.test(req.postData()), `body: ${req.postData()}`);
    assert(res.status() === 200, `status ${res.status()}`);
    await page.keyboard.press("Escape");
    await page.reload(); await rowOf("Owner B").waitFor();
    assert((await rowOf("Owner B").getByText("auto-paused", { exact: true }).count()) === 0, "still auto-paused after reload");
    const c = await api("e2e-owner-b");
    assert(c.quotaGuardState?.override === true && c.quotaGuardState?.paused === false, `state: ${JSON.stringify(c.quotaGuardState)}`);
    assert(!("quotaGuardResume" in c), "quotaGuardResume stored on row");
    const raw = sh("docker", ["exec", NAME, "node", "-e", `const D=require('better-sqlite3');const d=new D('/app/data/db/data.sqlite',{readonly:true});console.log(d.prepare("select data from providerConnections where id='e2e-owner-b'").get().data)`]);
    if (raw.status === 0) assert(!raw.stdout.includes("quotaGuardResume"), "quotaGuardResume present in raw DB row");
  });

  await check("No uncaught page errors", async () => { assert(pageErrors.length === 0, pageErrors.join(" | ")); });
} catch (e) {
  console.error("HARNESS ERROR:", e);
  results.push(["harness", false, e]);
} finally {
  try { await browser?.close(); } catch {}
  stopContainer();
  if (!KEEP) rmSync(dataDir, { recursive: true, force: true });
  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}
