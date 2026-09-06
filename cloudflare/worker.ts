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
    D1_URL: `${this.env.PUBLIC_URL}/_d1`, D1_TOKEN: this.env.INTERNAL_TOKEN,
  };

  override fetch(request: Request): Promise<Response> {
    // One writer owns this workspace. D1 persists data when the container sleeps.
    if (this.waiting >= 100) return Promise.resolve(unavailable());
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
    // Incoming headers cannot impersonate the private container transport.
    const headers = new Headers(request.headers);
    headers.delete(internalHeader);
    headers.set("x-threadpost-client-ip", request.headers.get("cf-connecting-ip") || "unknown");
    return env.CHAT.getByName("workspace").fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
