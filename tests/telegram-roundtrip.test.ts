import { test, expect } from "bun:test";
import { Store } from "../src/store";
import { Bridge } from "../src/bridge";
import { TelegramConnector } from "../src/connectors";
import { createApp } from "../src/app";
import type { Config } from "../src/config";

test("website → Telegram topic → authenticated operator reply → website", async () => {
  const config: Config = { host: "127.0.0.1", port: 8788, publicUrl: "https://chat.example",
    adminToken: "a".repeat(40), dbPath: ":memory:", siteId: "test", siteName: "Test",
    origins: ["https://chat.example"], connector: "telegram", telegramToken: "123:synthetic",
    telegramChatId: "-10042", telegramOperators: ["42"], webhookSecret: "s".repeat(40) };
  const requests: { method: string; payload: any }[] = [];
  const transport = (async (url: string | URL | Request, options?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    requests.push({ method, payload: JSON.parse(String(options?.body)) });
    return Response.json({ ok: true, result: method === "createForumTopic" ? { message_thread_id: 101 } : { message_id: 102 } });
  }) as typeof fetch;
  const store = new Store(":memory:");
  try {
    const bridge = new Bridge(store, new TelegramConnector(config, transport)), app = createApp(config, bridge);
    const request = (path: string, data: any, headers: Record<string, string> = {}) => new Request(config.publicUrl + path,
      { method: "POST", headers: { "Content-Type": "application/json", Origin: config.publicUrl, ...headers }, body: JSON.stringify(data) });
    const created = await (await app(request("/api/conversations", { siteId: "test", pageUrl: "https://chat.example/pricing?plan=pro#details" }))).json() as any;
    await app(request(`/api/conversations/${created.id}/messages`, { body: "Hello", clientMessageId: "message-one" }, { Authorization: `Bearer ${created.token}` }));
    await bridge.flush();
    expect(requests.map(r => r.method)).toEqual(["createForumTopic", "sendMessage"]);
    expect(requests[0].payload).toMatchObject({ chat_id: "-10042", name: "Test · Visitor " + created.id.slice(0, 8) + " · Reported page /pricing" });
    expect(requests[1].payload).toMatchObject({ chat_id: "-10042", message_thread_id: 101 });
    expect(requests[1].payload.text).toContain("New visitor context");
    expect(requests[1].payload.text).toContain("Site: Test");
    expect(requests[1].payload.text).toContain("Browser-reported name: Visitor");
    expect(requests[1].payload.text).toContain("Browser-reported page: https://chat.example/pricing");
    expect(requests[1].payload.text).toContain(`Conversation: ${created.id}`);
    expect(requests[1].payload.text).toContain(`Open admin: https://chat.example/admin?conversation=${created.id}`);
    await app(request(`/api/conversations/${created.id}/messages`, { body: "Second", clientMessageId: "message-two" }, { Authorization: `Bearer ${created.token}` }));
    await bridge.flush();
    expect(requests[2].payload.text).toBe("Visitor message\n\nSecond");
    const update = { update_id: 200, message: { chat: { id: -10042 }, from: { id: 42, is_bot: false }, message_thread_id: 101, text: "Hi there" } };
    expect((await app(request("/webhooks/telegram", update))).status).toBe(401);
    expect(store.messages(created.id)).toHaveLength(2);
    const webhook = () => app(request("/webhooks/telegram", update, { "X-Telegram-Bot-Api-Secret-Token": config.webhookSecret }));
    expect((await webhook()).status).toBe(200); await webhook();
    const result = await (await app(new Request(`${config.publicUrl}/api/conversations/${created.id}/messages`, { headers: { Authorization: `Bearer ${created.token}` } }))).json() as any;
    expect(result.messages.map((m: any) => m.body)).toEqual(["Hello", "Second", "Hi there"]);
  } finally { store.db.close(); }
});

test("Telegram topic context is labeled, sanitized, and bounded", async () => {
  const topicNames: string[] = [];
  const transport = (async (_url: string | URL | Request, options?: RequestInit) => {
    topicNames.push((JSON.parse(String(options?.body)) as { name: string }).name);
    return Response.json({ ok: true, result: { message_thread_id: 101 } });
  }) as typeof fetch;
  const contextualConfig: Config = { host: "127.0.0.1", port: 8788, publicUrl: "https://chat.example",
    adminToken: "a".repeat(40), dbPath: ":memory:", siteId: "test", siteName: "Trusted\nSite",
    origins: ["https://chat.example"], connector: "telegram", telegramToken: "123:synthetic",
    telegramChatId: "-10042", telegramOperators: ["42"], webhookSecret: "s".repeat(40) };
  const connector = new TelegramConnector(contextualConfig, transport);
  await connector.createThread("12345678-rest", { sourcePath: "/reported\npath\u202E" + "x".repeat(200) });
  expect(topicNames[0].startsWith("Trusted Site · Visitor 12345678 · Reported page /reported path")).toBe(true);
  expect(topicNames[0]).not.toMatch(/[\n\u202E]/);
  expect(Array.from(topicNames[0]).length).toBeLessThanOrEqual(128);
});

test("Telegram first-message context is sanitized and stays within its message limit", async () => {
  const sent: string[] = [];
  const transport = (async (_url: string | URL | Request, options?: RequestInit) => {
    sent.push((JSON.parse(String(options?.body)) as { text: string }).text);
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch;
  const contextualConfig: Config = { host: "127.0.0.1", port: 8788, publicUrl: "https://chat.example",
    adminToken: "a".repeat(40), dbPath: ":memory:", siteId: "test", siteName: "Trusted\nSite\u202E" + "s".repeat(200),
    origins: ["https://chat.example"], connector: "telegram", telegramToken: "123:synthetic",
    telegramChatId: "-10042", telegramOperators: ["42"], webhookSecret: "s".repeat(40) };
  const connector = new TelegramConnector(contextualConfig, transport);
  await connector.send("101", "x".repeat(2000), { firstInbound: true, conversation: {
    id: "conversation-1", name: "Reported\nName\u202E", createdAt: "2026-09-06T12:00:00.000Z",
    sourceOrigin: "https://chat.example", sourcePath: "/reported\npage\u202E",
  } });
  expect(sent[0]).not.toMatch(/[\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
  expect(sent[0]).toContain("Site: Trusted Site");
  expect(sent[0]).toContain("Browser-reported name: Reported Name");
  expect(sent[0]).toContain("Browser-reported page: https://chat.example/reported page");
  expect(Array.from(sent[0]).length).toBeLessThanOrEqual(4096);
  expect(sent[0].endsWith("x".repeat(2000))).toBe(true);
});
