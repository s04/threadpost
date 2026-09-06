import { timingSafeEqual } from "node:crypto";
import type { Config } from "./config";
import { Bridge } from "./bridge";
import { AppError, hash, secret, type Conversation } from "./store";
import type { TelegramSettings } from "./telegram-settings";
import { browserContext, conversationSource, verifyHuman } from "./abuse";

const safeEqual = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const cleanConversation = (row: Conversation) => ({ id: row.id, name: row.name, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
  sourceOrigin: row.sourceOrigin || null, sourcePath: row.sourcePath || null, blocked: Boolean(row.blocked) });
const json = (data: unknown, status = 200) => Response.json(data, { status });
const publicFiles: Record<string, string> = {
  "/": "index.html", "/admin": "admin.html", "/admin/": "admin.html",
  "/widget.js": "widget.js", "/site.css": "site.css", "/admin.js": "admin.js", "/admin.css": "admin.css",
};

class RateLimit {
  private entries = new Map<string, { until: number; count: number }>();
  allow(key: string, max: number) {
    const now = Date.now();
    if (this.entries.size >= 10000) for (const [id, row] of this.entries) if (row.until <= now) this.entries.delete(id);
    let entry = this.entries.get(key);
    if (!entry || entry.until <= now) {
      if (this.entries.size >= 10000) return false;
      entry = { until: now + 60_000, count: 0 }; this.entries.set(key, entry);
    }
    return ++entry.count <= max;
  }
}

async function body(request: Request): Promise<Record<string, any>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new AppError(415, "Use application/json.");
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, "A JSON body is required.");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 16_384) { await reader.cancel(); throw new AppError(413, "Request is too large."); }
    chunks.push(value);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new AppError(400, "Invalid JSON."); }
}
function messageInput(data: Record<string, any>) {
  if (typeof data.body !== "string" || !data.body.trim() || data.body.length > 2000)
    throw new AppError(400, "Messages must contain 1–2000 characters.");
  if (typeof data.clientMessageId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(data.clientMessageId))
    throw new AppError(400, "A unique clientMessageId is required.");
  return { text: data.body.trim(), clientId: data.clientMessageId };
}

export function createApp(config: Config, bridge: Bridge, options: { workspaceBinding?: string; telegram?: TelegramSettings; verifyHuman?: typeof verifyHuman } = {}) {
  const store = bridge.store, limiter = new RateLimit();
  const ready = Promise.resolve().then(() => store.bindWorkspace(
    options.workspaceBinding || `${config.siteId}:${config.connector}:${config.telegramChatId}:${config.telegramToken.split(":")[0]}`
  )).then(() => null, error => error);
  const sessionHash = (token: string) => hash(`threadpost:admin-session:${config.siteId}:${config.adminToken}:${token}`);
  const cookie = (token: string, age: number) => `threadpost_session=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${age}${config.publicUrl.startsWith("https:") ? "; Secure" : ""}`;
  const sessionKey = (request: Request) => sessionHash(request.headers.get("cookie")?.match(/(?:^|;\s*)threadpost_session=([^;]+)/)?.[1] || "");
  const originAllowed = (request: Request) => !request.headers.has("origin") || config.origins.includes(request.headers.get("origin")!);
  async function quota(key: string, max: number, periodMs: number, message: string) {
    if (!await store.consumeQuota(hash(`${config.adminToken}:${key}`), max, periodMs)) throw new AppError(429, message);
  }
  async function admin(request: Request) {
    if (!await store.validAdminSession(sessionKey(request), Date.now())) throw new AppError(401, "Sign in to continue.");
    if (request.method !== "GET" && request.headers.get("origin") !== config.publicUrl)
      throw new AppError(403, "Operator requests must come from this site's origin.");
  }
  return async (request: Request, ip = "local"): Promise<Response> => {
    const startupError = await ready;
    if (startupError) throw startupError;
    const url = new URL(request.url), path = url.pathname;
    let response: Response;
    try {
      if (path === "/healthz" && request.method === "GET") response = json({ ok: true });
      else if (path === "/api/widget-config" && ["GET", "OPTIONS"].includes(request.method)) {
        if (!originAllowed(request)) throw new AppError(403, "This website is not allowed to use this inbox.");
        if (url.searchParams.get("siteId") !== config.siteId) throw new AppError(404, "Site not found.");
        response = request.method === "OPTIONS" ? new Response(null, { status: 204 })
          : json({ siteId: config.siteId, turnstileSiteKey: config.turnstileSiteKey || null });
      }
      else if (path === "/webhooks/telegram" && request.method === "POST") {
        if (config.connector !== "telegram" || !safeEqual(request.headers.get("x-telegram-bot-api-secret-token") || "", config.webhookSecret))
          throw new AppError(401, "Invalid webhook signature.");
        await bridge.telegram(await body(request), config); response = json({ ok: true });
      } else if (path === "/api/admin/login" && request.method === "POST") {
        if (request.headers.get("origin") !== config.publicUrl) throw new AppError(403, "Invalid origin.");
        if (!limiter.allow(`login:${ip}`, 10)) throw new AppError(429, "Too many attempts. Try again in a minute.");
        await quota(`login:${ip}`, 10, 60_000, "Too many attempts. Try again in a minute.");
        const data = await body(request);
        if (typeof data.token !== "string" || !safeEqual(data.token, config.adminToken)) throw new AppError(401, "Incorrect operator token.");
        const sessionAge = data.rememberSession === true ? 30 * 24 * 3600 : 8 * 3600;
        const token = secret(), now = Date.now();
        if (!await store.createAdminSession(sessionHash(token), now + sessionAge * 1000, now))
          throw new AppError(429, "Too many active operator sessions. Sign out on another device and try again.");
        response = json({ ok: true }); response.headers.set("Set-Cookie", cookie(token, sessionAge));
      } else if (path.startsWith("/api/admin/")) {
        await admin(request);
        if (path === "/api/admin/logout" && request.method === "POST") {
          await store.deleteAdminSession(sessionKey(request)); response = json({ ok: true }); response.headers.set("Set-Cookie", cookie("", 0));
        } else if (path === "/api/admin/telegram") {
          if (!options.telegram) throw new AppError(503, "Telegram setup is unavailable in this host.");
          if (request.method === "GET") response = json(await options.telegram.status());
          else if (request.method === "POST") {
            await quota("telegram-setup", 5, 60_000, "Too many setup attempts. Try again in a minute.");
            const data = await body(request);
            if (typeof data.botToken !== "string" || typeof data.chatId !== "string"
              || !Array.isArray(data.operatorIds) || data.operatorIds.some((id: unknown) => typeof id !== "string"))
              throw new AppError(400, "Enter the bot token, group ID and operator IDs.");
            response = json(await options.telegram.connect({ botToken: data.botToken, chatId: data.chatId, operatorIds: data.operatorIds }));
          } else throw new AppError(405, "Method not allowed.");
        } else if (path === "/api/admin/overview" && request.method === "GET") {
          response = json({ site: { id: config.siteId, name: config.siteName, origins: config.origins },
            connector: { kind: config.connector, configured: config.connector === "telegram" }, counts: await store.counts(),
            embedScript: `<script src="${config.publicUrl}/widget.js" data-site="${config.siteId}" defer></script>` });
        } else if (path === "/api/admin/conversations" && request.method === "GET") response = json({ conversations: await store.list() });
        else {
          const conversation = path.match(/^\/api\/admin\/conversations\/([a-zA-Z0-9-]+)(\/messages)?$/);
          const retry = path.match(/^\/api\/admin\/messages\/(\d+)\/retry$/);
          if (retry && request.method === "POST") response = json(await bridge.retry(Number(retry[1])));
          else if (conversation) {
            const id = conversation[1]; await store.require(id);
            if (request.method === "GET" && !conversation[2]) response = json({ conversation: cleanConversation(await store.require(id)), messages: await store.messages(id) });
            else if (request.method === "POST" && conversation[2]) {
              const input = messageInput(await body(request)); response = json(await store.add(id, "outbound", input.text, input.clientId));
            } else if (request.method === "PATCH" && !conversation[2]) {
              const data = await body(request);
              if (typeof data.blocked === "boolean") {
                if (bridge.busy) throw new AppError(409, "Delivery is in progress. Try again shortly.");
                response = json(cleanConversation(await store.setBlocked(id, data.blocked)));
              } else {
                if (!["open", "closed"].includes(data.status)) throw new AppError(400, "Invalid conversation status.");
                response = json(cleanConversation(await store.setStatus(id, data.status)));
              }
            } else if (request.method === "DELETE" && !conversation[2]) {
              if (bridge.busy) throw new AppError(409, "Delivery is in progress. Try deletion again shortly.");
              await store.delete(id); response = json({ ok: true });
            } else throw new AppError(405, "Method not allowed.");
          } else throw new AppError(404, "Not found.");
        }
      } else if (path.startsWith("/api/conversations")) {
        if (!originAllowed(request)) throw new AppError(403, "This website is not allowed to use this inbox.");
        if (request.method === "OPTIONS") response = new Response(null, { status: 204 });
        else if (path === "/api/conversations" && request.method === "POST") {
          if (!limiter.allow(`start:${ip}`, 20)) throw new AppError(429, "Too many attempts. Try again in a minute.");
          const data = await body(request);
          if (data.siteId !== config.siteId) throw new AppError(404, "Site not found.");
          if (data.name != null && (typeof data.name !== "string" || data.name.length > 80)) throw new AppError(400, "Name must be at most 80 characters.");
          if (data.clientToken != null && (typeof data.clientToken !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(data.clientToken)))
            throw new AppError(400, "clientToken must be a random 32-byte base64url secret.");
          const existing = data.clientToken ? await store.findByToken(data.clientToken) : null;
          if (existing) {
            await store.authenticate(existing.id, data.clientToken);
            if (existing.sourceOrigin && request.headers.get("origin") && existing.sourceOrigin !== request.headers.get("origin"))
              throw new AppError(403, "This chat belongs to another website.");
            if (existing.blocked) throw new AppError(403, "This conversation is blocked.");
            response = json({ id: existing.id, token: data.clientToken, status: existing.status }, 201);
          } else {
            await quota(`start:${ip}`, 5, 60_000, "Too many new conversations. Try again in a minute.");
            await (options.verifyHuman || verifyHuman)(config, data.turnstileToken, request.headers.get("origin"), ip);
            await quota(`start-day:${ip}`, 20, 86_400_000, "Too many new conversations today. Try again later.");
            await quota("start-day:workspace", config.maxNewConversationsPerDay || 200, 86_400_000, "This inbox has reached its daily conversation limit.");
            response = json(await store.create((data.name || "").trim(), data.clientToken, {
              ...conversationSource(request, data.pageUrl), ...browserContext(data.referrerUrl, data.language, data.timezone),
            }), 201);
          }
        } else {
          const match = path.match(/^\/api\/conversations\/([a-zA-Z0-9-]+)(\/messages)?$/);
          if (!match) throw new AppError(404, "Not found.");
          if (!limiter.allow(`visitor:${ip}`, 240)) throw new AppError(429, "Too many requests. Try again in a minute.");
          const row = await store.authenticate(match[1], request.headers.get("authorization")?.replace(/^Bearer /, "") || "");
          if (row.sourceOrigin && request.headers.get("origin") && row.sourceOrigin !== request.headers.get("origin"))
            throw new AppError(403, "This chat belongs to another website.");
          if (request.method === "DELETE" && !match[2]) {
            if (bridge.busy) throw new AppError(409, "Delivery is in progress. Try again shortly.");
            await store.delete(row.id); response = json({ ok: true });
          } else if (request.method === "GET" && match[2]) response = json({ conversation: cleanConversation(row), messages: await store.messages(row.id) });
          else if (request.method === "POST" && match[2]) {
            if (row.blocked) throw new AppError(403, "This conversation is blocked.");
            const input = messageInput(await body(request));
            const old = await store.findMessage(row.id, "inbound", input.clientId);
            if (old) {
              if (old.body !== input.text) throw new AppError(409, "This message ID was already used for different text.");
              response = json(old, 201);
            } else {
              await quota(`message:${row.id}`, 30, 60_000, "Too many messages. Try again in a minute.");
              await quota(`message-ip:${ip}`, 120, 60_000, "Too many messages. Try again in a minute.");
              await quota("message-day:workspace", config.maxMessagesPerDay || 5000, 86_400_000, "This inbox has reached its daily message limit.");
              response = json(await store.add(row.id, "inbound", input.text, input.clientId), 201);
            }
          } else throw new AppError(405, "Method not allowed.");
        }
      } else if (request.method === "GET" && publicFiles[path]) {
        const file = Bun.file(new URL(`../public/${publicFiles[path]}`, import.meta.url));
        response = path === "/" ? new Response((await file.text()).replace('data-site="demo"', `data-site="${config.siteId}"`),
          { headers: { "Content-Type": "text/html; charset=utf-8" } }) : new Response(file);
      } else throw new AppError(404, "Not found.");
    } catch (error) {
      response = error instanceof AppError ? json({ error: error.message }, error.status) : json({ error: "Request failed. Please try again." }, 500);
    }
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Cache-Control", "no-store");
    if (response.status === 429) response.headers.set("Retry-After", "60");
    if ((path.startsWith("/api/conversations") || path === "/api/widget-config") && request.headers.get("origin") && originAllowed(request)) {
      response.headers.set("Access-Control-Allow-Origin", request.headers.get("origin")!);
      response.headers.set("Vary", "Origin");
      response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      response.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      response.headers.set("Access-Control-Expose-Headers", "Retry-After");
    }
    if (path === "/" || path.startsWith("/admin")) {
      response.headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://challenges.cloudflare.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      response.headers.set("X-Frame-Options", "DENY");
    }
    return response;
  };
}
