import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { Bridge } from "../src/bridge";
import type { Config } from "../src/config";
import { DemoConnector } from "../src/connectors";
import { AppError, Store } from "../src/store";

const origin = "https://allowed.example", otherOrigin = "https://other.example";
const config = (): Config => ({ host: "127.0.0.1", port: 8788, publicUrl: "https://chat.example",
  adminToken: "a".repeat(40), dbPath: ":memory:", siteId: "test", siteName: "Test",
  origins: ["https://chat.example", origin, otherOrigin], connector: "demo", telegramToken: "", telegramChatId: "",
  telegramOperators: [], webhookSecret: "", turnstileSiteKey: "public-site-key", turnstileSecret: "private-secret-key",
  maxNewConversationsPerDay: 200, maxMessagesPerDay: 5000 });
const stores: Store[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); });

function harness() {
  const cfg = config(), store = new Store(":memory:"); stores.push(store);
  const verification: unknown[][] = [];
  const verifyHuman = (async (_config: Config, token: unknown, requestOrigin: string | null, ip: string) => {
    verification.push([token, requestOrigin, ip]);
    if (token !== "human-pass") throw new AppError(403, "Complete the verification before starting a chat.");
  }) as NonNullable<Parameters<typeof createApp>[2]>["verifyHuman"];
  const app = createApp(cfg, new Bridge(store, new DemoConnector()), { workspaceBinding: "test:messaging", verifyHuman });
  const call = (path: string, options: { method?: string; origin?: string; body?: unknown; token?: string } = {}) => {
    const headers = new Headers();
    if (options.origin) headers.set("Origin", options.origin);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
    return app(new Request(cfg.publicUrl + path, { method: options.method || "GET", headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body) }), "203.0.113.9");
  };
  return { cfg, store, app, call, verification };
}

describe("messaging API", () => {
  test("widget config exposes only the public site key", async () => {
    const { call } = harness();
    const response = await call("/api/widget-config?siteId=test", { origin });
    expect(response.status).toBe(200);
    const data = await response.json() as Record<string, unknown>;
    expect(data).toEqual({ siteId: "test", turnstileSiteKey: "public-site-key" });
    expect(JSON.stringify(data)).not.toContain("private-secret-key");
  });

  test("requires human verification only for new tokens and keeps source attribution immutable on retry", async () => {
    const { call, store, verification } = harness(), clientToken = "A".repeat(43);
    const missing = await call("/api/conversations", { method: "POST", origin,
      body: { siteId: "test", clientToken, pageUrl: `${origin}/pricing?plan=pro#checkout` } });
    expect(missing.status).toBe(403); expect(verification).toHaveLength(1);
    const createdResponse = await call("/api/conversations", { method: "POST", origin,
      body: { siteId: "test", clientToken, turnstileToken: "human-pass", pageUrl: `${origin}/pricing?plan=pro#checkout` } });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: string; token: string };
    expect(store.conversation(created.id)).toMatchObject({ sourceOrigin: origin, sourcePath: "/pricing" });
    expect(verification).toHaveLength(2);

    const retried = await call("/api/conversations", { method: "POST", origin,
      body: { siteId: "test", clientToken, name: "Changed", pageUrl: `${origin}/different?ignored=1` } });
    expect(retried.status).toBe(201); expect((await retried.json() as any).id).toBe(created.id);
    expect(verification).toHaveLength(2);
    expect(store.conversation(created.id)).toMatchObject({ name: "Visitor", sourceOrigin: origin, sourcePath: "/pricing" });

    const crossOrigin = await call("/api/conversations", { method: "POST", origin: otherOrigin,
      body: { siteId: "test", clientToken } });
    expect(crossOrigin.status).toBe(403); expect(verification).toHaveLength(2);
  });

  test("visitor deletion requires the matching token and invalidates it", async () => {
    const { call } = harness();
    const create = async (clientToken: string) => {
      const response = await call("/api/conversations", { method: "POST", origin,
        body: { siteId: "test", clientToken, turnstileToken: "human-pass", pageUrl: `${origin}/support` } });
      return response.json() as Promise<{ id: string; token: string }>;
    };
    const first = await create("A".repeat(43)), second = await create("B".repeat(43));
    expect((await call(`/api/conversations/${first.id}`, { method: "DELETE", origin, token: second.token })).status).toBe(401);
    expect((await call(`/api/conversations/${first.id}`, { method: "DELETE", origin, token: first.token })).status).toBe(200);
    expect((await call(`/api/conversations/${first.id}/messages`, { origin, token: first.token })).status).toBe(401);
  });
});
