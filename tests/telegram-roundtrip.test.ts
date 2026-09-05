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
    const created = await (await app(request("/api/conversations", { siteId: "test" }))).json() as any;
    await app(request(`/api/conversations/${created.id}/messages`, { body: "Hello", clientMessageId: "message-one" }, { Authorization: `Bearer ${created.token}` }));
    await bridge.flush();
    expect(requests.map(r => r.method)).toEqual(["createForumTopic", "sendMessage"]);
    expect(requests[1].payload).toMatchObject({ chat_id: "-10042", message_thread_id: 101, text: "Visitor message\n\nHello" });
    const update = { update_id: 200, message: { chat: { id: -10042 }, from: { id: 42, is_bot: false }, message_thread_id: 101, text: "Hi there" } };
    expect((await app(request("/webhooks/telegram", update))).status).toBe(401);
    expect(store.messages(created.id)).toHaveLength(1);
    const webhook = () => app(request("/webhooks/telegram", update, { "X-Telegram-Bot-Api-Secret-Token": config.webhookSecret }));
    expect((await webhook()).status).toBe(200); await webhook();
    const result = await (await app(new Request(`${config.publicUrl}/api/conversations/${created.id}/messages`, { headers: { Authorization: `Bearer ${created.token}` } }))).json() as any;
    expect(result.messages.map((m: any) => m.body)).toEqual(["Hello", "Hi there"]);
  } finally { store.db.close(); }
});
