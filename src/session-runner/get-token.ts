/**
 * get-token.ts — Headless browser login to Ziila → extract accessToken cookie
 * → write it to .env as WS_TOKEN.  Run with: npm run get-token
 */
import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, ".env");

function readEnv(): Record<string, string> {
  const raw = fs.readFileSync(ENV_PATH, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function setEnvValue(key: string, value: string): void {
  let raw = fs.readFileSync(ENV_PATH, "utf8");
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(raw)) {
    raw = raw.replace(re, `${key}=${value}`);
  } else {
    raw += `\n${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, raw, "utf8");
}

async function main() {
  const env = readEnv();
  const appUrl = env.APP_URL || "";
  const email = env.ZILLA_EMAIL || "";
  const password = env.ZILLA_PASSWORD || "";
  const loginPath = env.LOGIN_PATH || "{locale}/auth/login";
  const locale = env.APP_LOCALE || "en";

  if (!appUrl) throw new Error("APP_URL not set in .env");
  if (!email) throw new Error("ZILLA_EMAIL not set in .env");
  if (!password) throw new Error("ZILLA_PASSWORD not set in .env");

  const loginUrl = `${appUrl}/${loginPath.replace("{locale}", locale)}`;
  console.log(`Opening ${loginUrl} ...`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);

  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((u: URL) => !u.pathname.includes("/auth/login"), {
      timeout: 20_000,
    });
    console.log("Login successful.");

    const cookies = await ctx.cookies();
    const token = cookies.find((c) => c.name === "accessToken")?.value;
    if (!token) throw new Error("no accessToken cookie found after login");

    setEnvValue("WS_TOKEN", token);
    console.log(`WS_TOKEN updated in .env (length=${token.length})`);

    // Show expiry info from the JWT payload
    try {
      const payload = JSON.parse(
        Buffer.from(token.split(".")[1], "base64url").toString(),
      );
      const exp = new Date(payload.exp * 1000);
      console.log(`Token expires: ${exp.toISOString()} (${Math.round((payload.exp * 1000 - Date.now()) / 60_000)} min from now)`);
    } catch {
      // JWT parse failed — not critical
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("get-token failed:", e.message);
  process.exit(1);
});
