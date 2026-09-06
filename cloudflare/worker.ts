import { Container } from "@cloudflare/containers";

interface Env {
  CHAT: DurableObjectNamespace<ChatContainer>;
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  INTERNAL_TOKEN: string;
  PUBLIC_URL: string;
  SITE_ID: string;
  SITE_NAME: string;
  ALLOWED_ORIGINS: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  MAX_NEW_CONVERSATIONS_PER_DAY?: string;
  MAX_MESSAGES_PER_DAY?: string;
  EDGE_RATE_LIMIT: RateLimit;
  START_RATE_LIMIT: RateLimit;
  WORKSPACE_RATE_LIMIT: RateLimit;
}

const internalHeader = "x-threadpost-internal";
const unavailable = () => Response.json({ error: "Chat is temporarily unavailable. Please try again." },
  { status: 503, headers: { "Cache-Control": "no-store" } });

export class ChatContainer extends Container<Env> {
  defaultPort = 8788;
  sleepAfter = "2m";
  private queue: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  envVars = {
    HOST: "0.0.0.0", PORT: "8788", CONNECTOR: "demo",
    PUBLIC_URL: this.env.PUBLIC_URL, SITE_ID: this.env.SITE_ID,
    SITE_NAME: this.env.SITE_NAME, ALLOWED_ORIGINS: this.env.ALLOWED_ORIGINS,
    ADMIN_TOKEN: this.env.ADMIN_TOKEN, CONTAINER_INTERNAL_TOKEN: this.env.INTERNAL_TOKEN,
    SETTINGS_KEY: this.env.INTERNAL_TOKEN,
    TURNSTILE_SITE_KEY: this.env.TURNSTILE_SITE_KEY || "", TURNSTILE_SECRET_KEY: this.env.TURNSTILE_SECRET_KEY || "",
    MAX_NEW_CONVERSATIONS_PER_DAY: this.env.MAX_NEW_CONVERSATIONS_PER_DAY || "200",
    MAX_MESSAGES_PER_DAY: this.env.MAX_MESSAGES_PER_DAY || "5000",
    D1_URL: `${this.env.PUBLIC_URL}/_d1`, D1_TOKEN: this.env.INTERNAL_TOKEN,
  };

  override fetch(request: Request): Promise<Response> {
    // One writer owns this workspace. D1 persists data when the container sleeps.
    if (this.waiting >= 32) return Promise.resolve(unavailable());
    this.waiting++;
    const result = this.queue.then(async () => {
      const headers = new Headers(request.headers);
      headers.set(internalHeader, this.env.INTERNAL_TOKEN);
      try {
        const response = await this.containerFetch(new Request(request, { headers }));
        // Consume before releasing the queue, including any database work.
        return new Response(await response.arrayBuffer(), response);
      } catch {
        return unavailable();
      }
    }).finally(() => { this.waiting--; });
    this.queue = result.catch(() => {});
    return result;
  }
}

async function equalSecret(value: string, expected: string): Promise<boolean> {
  if (!expected || expected.length < 32) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([value, expected].map(s => crypto.subtle.digest("SHA-256", encoder.encode(s))));
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/_d1") {
      if (request.method !== "POST" || !await equalSecret(request.headers.get(internalHeader) || "", env.INTERNAL_TOKEN))
        return new Response("Not found", { status: 404 });
      try {
        const reader = request.body?.getReader();
        if (!reader) return new Response(null, { status: 400 });
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length;
          if (size > 65_536) { await reader.cancel(); return new Response(null, { status: 413 }); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const statements: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!Array.isArray(statements) || statements.length < 1 || statements.length > 50)
          return new Response(null, { status: 400 });
        const prepared = statements.map(statement => {
          if (!statement || typeof statement.sql !== "string" || !Array.isArray(statement.params)
            || statement.params.some((v: unknown) => v !== null && typeof v !== "string" && typeof v !== "number"))
            throw new Error("Invalid statement");
          return env.DB.prepare(statement.sql).bind(...statement.params);
        });
        return Response.json(await env.DB.batch(prepared), { headers: { "Cache-Control": "no-store" } });
      } catch { return unavailable(); }
    }
    if (path.startsWith("/_")) return new Response("Not found", { status: 404 });
    if (request.method === "GET" && ["/widget.js", "/admin.js", "/admin.css", "/site.css"].includes(path))
      return env.ASSETS.fetch(request);
    const widgetRoute = path.startsWith("/api/conversations") || path === "/api/widget-config";
    const origin = request.headers.get("origin");
    const allowed = [env.PUBLIC_URL, ...env.ALLOWED_ORIGINS.split(",").map(s => s.trim())];
    const cors: Record<string, string> = origin && allowed.includes(origin) ? {
      "Access-Control-Allow-Origin": origin, "Vary": "Origin",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Expose-Headers": "Retry-After",
    } : {};
    if (widgetRoute && origin && !allowed.includes(origin))
      return Response.json({ error: "This website is not allowed to use this inbox." }, { status: 403 });
    if (widgetRoute && request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const knownPath = ["/", "/admin", "/admin/", "/healthz", "/api/widget-config", "/webhooks/telegram"].includes(path)
      || /^\/api\/(admin\/|conversations(?:\/|$))/.test(path);
    if (!knownPath) return new Response("Not found", { status: 404 });
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env.INTERNAL_TOKEN}:${ip}`));
    const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    const general = await env.EDGE_RATE_LIMIT.limit({ key });
    const workspace = await env.WORKSPACE_RATE_LIMIT.limit({ key: "dynamic-requests" });
    const starting = path === "/api/conversations" && request.method === "POST";
    const start = starting ? await env.START_RATE_LIMIT.limit({ key }) : { success: true };
    if (!general.success || !workspace.success || !start.success)
      return Response.json({ error: "Too many requests. Please wait a minute." }, {
        status: 429, headers: { ...cors, "Retry-After": "60", "Cache-Control": "no-store" },
      });
    if (path === "/api/widget-config" && request.method === "GET") {
      if (new URL(request.url).searchParams.get("siteId") !== env.SITE_ID) return new Response("Not found", { status: 404 });
      return Response.json({ siteId: env.SITE_ID, turnstileSiteKey: env.TURNSTILE_SITE_KEY || null },
        { headers: { ...cors, "Cache-Control": "no-store" } });
    }
    // Incoming headers cannot impersonate the private container transport.
    const headers = new Headers(request.headers);
    headers.delete(internalHeader);
    headers.set("x-threadpost-client-ip", ip);
    return env.CHAT.getByName("workspace").fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
