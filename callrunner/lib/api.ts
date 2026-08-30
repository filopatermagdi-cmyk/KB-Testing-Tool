// Backend API client: auth token from cookies + the conversation/agent endpoints
// the run uses to resolve an agent and confirm persistence. All calls go through
// Playwright's request context (shares the logged-in session).
import type { BrowserContext } from 'playwright';
import { CFG, CONVERSATION_PAGE_SIZE } from './config';

export function accessTokenFromCookies(
  cookies: Array<{ name: string; value: string }>,
): string | undefined {
  return cookies.find((c) => c.name === 'accessToken')?.value;
}

export async function pickFirstAgentId(context: BrowserContext): Promise<string> {
  const token = accessTokenFromCookies(await context.cookies());
  if (!token) throw new Error('no accessToken cookie after login');
  const res = await context.request.get(`${CFG.apiBase}/agent`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok()) throw new Error(`GET /agent failed: HTTP ${res.status()}`);
  const body = await res.json();
  // AgentListDataResponse shape varies — dig for the first array of objects with an id.
  const arr = body?.data?.items || body?.items || body?.data || body;
  const list = Array.isArray(arr) ? arr : Array.isArray(arr?.data) ? arr.data : [];
  const first = list.find((a: any) => a && a.id);
  if (!first)
    throw new Error(
      `could not find an agent in GET /agent response: ${JSON.stringify(body).slice(0, 300)}`,
    );
  return first.id;
}

export function parseIsoMs(value: string | null | undefined): number | null {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function apiGetJson(
  context: BrowserContext,
  token: string,
  url: string,
): Promise<any> {
  const res = await context.request.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok()) throw new Error(`GET ${url} failed: HTTP ${res.status()}`);
  return res.json();
}

// The frontend consults this on Start-call click and SILENTLY no-ops when
// remainingConversations is 0 — the only visible symptom is "End button never
// appears". Checking it ourselves turns that useless timeout into a clear verdict.
export async function fetchRemainingConversations(context: BrowserContext): Promise<number | null> {
  try {
    const token = accessTokenFromCookies(await context.cookies());
    if (!token) return null;
    const body = await apiGetJson(context, token, `${CFG.apiBase}/accounts/consumption-details`);
    const n = body?.remainingConversations;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // diagnostics only — never mask the original failure
  }
}

export async function fetchRecentConversations(
  context: BrowserContext,
  token: string,
  agentId: string,
  pageSize: number = CONVERSATION_PAGE_SIZE,
): Promise<any[]> {
  const url = new URL(`${CFG.apiBase}/conversations`);
  url.searchParams.set('pageIndex', '0');
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.append('agentIds[]', agentId);
  const body = await apiGetJson(context, token, url.toString());
  return Array.isArray(body?.data) ? body.data : [];
}

export async function fetchConversation(
  context: BrowserContext,
  token: string,
  conversationId: string,
): Promise<any> {
  return apiGetJson(context, token, `${CFG.apiBase}/conversations/${conversationId}`);
}
