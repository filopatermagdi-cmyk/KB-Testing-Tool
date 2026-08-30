/*
 * agents.ts - resolve Zilla agents by NAME, so switching agents is a .env edit
 * (no code changes).
 *
 * It logs into Zilla (same UI login CallRunner uses), fetches the account's
 * agent list via GET /agent, then:
 *
 *   - lists every agent (id + name) so you can see what to type into .env
 *   - if ZILLA_AGENT_AR / ZILLA_AGENT_EN (names) are set, matches each against
 *     the agent list and writes the resolved id into ZILLA_AGENT_ID_AR/EN.
 *
 * Usage:
 *   npm run agents                     # list agents + resolve names from .env
 *   npm run agents -- --list           # list only, never write .env
 *   npm run agents -- --json           # machine output (JSON to stdout)
 *
 * Workflow to switch the Arabic agent, for example:
 *   1. edit .env:  ZILLA_AGENT_AR=اسم الوكيل
 *   2. npm run agents
 *   3. ZILLA_AGENT_ID_AR is updated automatically - run sessions as usual.
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, ".env");

const appUrl = (process.env.APP_URL || "").replace(/\/+$/, "");
const apiBase = (process.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
const email = process.env.ZILLA_EMAIL || "";
const password = process.env.ZILLA_PASSWORD || "";
const locale = process.env.APP_LOCALE || "en";

const ARGS = {
  json: process.argv.includes("--json"),
  listOnly: process.argv.includes("--list"),
};

function info(...a: unknown[]): void {
  if (ARGS.json) process.stderr.write(a.join(" ") + "\n");
  else console.log(...a);
}

// .env write that preserves comments and line order (same approach as the UI server).
function writeEnvValues(values: Record<string, string>): void {
  const text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const lines = text.split(/\r?\n/);
  const updated = lines.map((line) => {
    const m = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (m && m[2] in values) {
      const v = values[m[2]];
      const needsQuote = /[\s#]/.test(v) && !/^".*"$/.test(v);
      return `${m[1]}${m[2]}${m[3]}${needsQuote ? `"${v}"` : v}`;
    }
    return line;
  });
  fs.writeFileSync(ENV_PATH, updated.join("\n"), "utf8");
}

async function fetchAgents(): Promise<any[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    info(`logging in to ${appUrl} ...`);
    await page.goto(`${appUrl}/${locale}/auth/login`, { waitUntil: "domcontentloaded" });
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((u) => !u.pathname.includes("/auth/login"), { timeout: 30000 });

    const cookies = await context.cookies();
    const token = cookies.find((c) => c.name === "accessToken")?.value;
    if (!token) throw new Error("no accessToken cookie after login");
    info("listing agents via GET /agent ...");
    const res = await context.request.get(`${apiBase}/agent`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok()) throw new Error(`GET /agent failed: HTTP ${res.status()}`);
    const body = await res.json();
    const arr = body?.data?.items || body?.items || body?.data || body;
    const list = Array.isArray(arr) ? arr : Array.isArray(arr?.data) ? arr.data : [];
    return list.filter((a: any) => a && a.id);
  } finally {
    await browser.close().catch(() => {});
  }
}

function labelOf(a: any): string {
  return String(
    a?.name || a?.displayName || a?.title || a?.agent_name || a?.label || a?.id || ""
  );
}

async function main(): Promise<void> {
  if (!appUrl || !apiBase || !email || !password) {
    console.error(
      "missing config: APP_URL, VITE_API_BASE_URL, ZILLA_EMAIL, ZILLA_PASSWORD must be set in .env"
    );
    process.exit(1);
  }

  const agents = await fetchAgents();
  if (!agents.length) {
    console.error("no agents returned by GET /agent (empty list)");
    process.exit(1);
  }

  const list = agents.map((a) => ({
    id: a.id,
    name: labelOf(a),
    language: String(a?.language || a?.locale || a?.default_language || ""),
  }));
  info("");
  info(`Agents available (${list.length}):`);
  for (const a of list)
    info(`  ${a.id.padEnd(40)}  ${a.name}${a.language ? `  [${a.language}]` : ""}`);

  if (ARGS.listOnly) {
    if (ARGS.json) console.log(JSON.stringify(list));
    return;
  }

  const targets = [
    { nameVar: "ZILLA_AGENT_AR", idVar: "ZILLA_AGENT_ID_AR", label: "Arabic (AR)" },
    { nameVar: "ZILLA_AGENT_EN", idVar: "ZILLA_AGENT_ID_EN", label: "English (EN)" },
  ];
  const updates: Record<string, string> = {};
  let changed = false;
  for (const t of targets) {
    const name = (process.env[t.nameVar] || "").trim();
    if (!name) continue;
    const matches = agents.filter((a) => labelOf(a).toLowerCase().includes(name.toLowerCase()));
    if (matches.length === 1) {
      updates[t.idVar] = matches[0].id;
      info(`Resolved ${t.label} "${name}" -> ${matches[0].id}`);
      changed = true;
    } else if (matches.length === 0) {
      info(`WARN: no agent name contains "${name}" (${t.label}) - nothing written`);
    } else {
      info(
        `WARN: ${matches.length} agents contain "${name}" (${t.label}) - be more specific:\n` +
          matches.map((m) => `         ${labelOf(m)}`).join("\n")
      );
    }
  }

  if (changed) {
    writeEnvValues(updates);
    info("Updated ZILLA_AGENT_ID_AR / ZILLA_AGENT_ID_EN in .env");
  } else {
    info(
      "Nothing to resolve. Set ZILLA_AGENT_AR / ZILLA_AGENT_EN (agent names) in .env and re-run, " +
        "or pick the id from the list above."
    );
  }

  if (ARGS.json) console.log(JSON.stringify({ agents: list, updated: changed, updates }));
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});