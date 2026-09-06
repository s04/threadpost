import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Store, type Storage } from "../src/store";
import { D1Store } from "../src/d1-store";
import { SQLiteD1Transport } from "./support/sqlite-d1";
import { Bridge } from "../src/bridge";
import { TelegramConnector } from "../src/connectors";
import { createApp } from "../src/app";
import { createRuntimeHandler } from "../src/runtime";
import type { Config } from "../src/config";

for (const backend of ["SQLite", "D1"] as const) {
  test(`${backend}: delete/recreate, stale tokens, webhook replay and operator isolation through HTTP`, async () => {
    const db = backend === "D1" ? new Database(":memory:") : null;
    const store: Storage = db ? new D1Store(new SQLiteD1Transport(db)) : new Store(":memory:");
    await store.ready();
    const config: Config = { host: "127.0.0.1", port: 8788, publicUrl: "https://chat.example", adminToken: "a".repeat(40),
      dbPath: ":memory:", siteId: "test", siteName: "Test", origins: ["https://chat.example"], connector: "telegram",
      telegramToken: "123:synthetic", telegramChatId: "-10042", telegramOperators: ["42"], webhookSecret: "s".repeat(40) };
    let topic = 100;
    const sent: { topic: number; text: string }[] = [];
    const transport = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/createForumTopic")) return Response.json({ ok: true, result: { message_thread_id: ++topic } });
      const payload = JSON.parse(String(init?.body)); sent.push({ topic: payload.message_thread_id, text: payload.text });
      return Response.json({ ok: true, result: { message_id: sent.length } });
    }) as typeof fetch;
    const bridge = new Bridge(store, new TelegramConnector(config, transport));
    // D1-style request flushing is deliberately exercised against both stores.
    const handler = createRuntimeHandler({ handler: createApp(config, bridge), bridge, useD1: true, internalToken: "" });
    const request = (path: string, method = "GET", data?: unknown, token?: string, webhookSecret?: string) => handler(new Request(config.publicUrl + path, {
      method, headers: { Origin: config.publicUrl, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(webhookSecret ? { "X-Telegram-Bot-Api-Secret-Token": webhookSecret } : {}) }, body: data === undefined ? undefined : JSON.stringify(data),
    }));
    const create = async (name: string) => {
      const response = await request("/api/conversations", "POST", { siteId: "test", name }); expect(response.status).toBe(201);
      return response.json() as Promise<{ id: string; token: string }>;
    };
    const send = (c: { id: string; token: string }, body: string) => request(`/api/conversations/${c.id}/messages`, "POST", { body, clientMessageId: "stable-message-id" }, c.token);
    try {
      const old = await create("Bob"), other = await create("Alice");
      expect((await send(old, "Original Bob")).status).toBe(201);
      expect((await send(old, "Original Bob")).status).toBe(201);
      expect(sent).toHaveLength(1); // Retrying the HTTP request cannot duplicate Telegram delivery.
      expect((await send(other, "Keep Alice")).status).toBe(201);
      const oldTopic = (await store.require(old.id)).threadId!;
      expect((await request(`/api/conversations/${old.id}`, "DELETE", undefined, old.token)).status).toBe(200);
      const fresh = await create("Bob"); expect(fresh.id).not.toBe(old.id);
      expect((await send(fresh, "Fresh Bob")).status).toBe(201);
      const newTopic = (await store.require(fresh.id)).threadId!; expect(newTopic).not.toBe(oldTopic);
      expect((await request(`/api/conversations/${old.id}/messages`, "GET", undefined, old.token)).status).toBe(401);
      expect((await request(`/api/conversations/${fresh.id}/messages`, "GET", undefined, old.token)).status).toBe(401);
      const update = (id: number, thread: string, operator = 42, group = -10042) => ({ update_id: id,
        message: { chat: { id: group }, from: { id: operator, is_bot: false }, message_thread_id: Number(thread), text: "Operator answer" } });
      expect((await request("/webhooks/telegram", "POST", update(200, newTopic))).status).toBe(401);
      for (const data of [update(201, oldTopic), update(202, newTopic, 99), update(203, newTopic, 42, -10099)]) {
        expect((await request("/webhooks/telegram", "POST", data, undefined, config.webhookSecret)).status).toBe(200);
      }
      expect(await store.messages(fresh.id)).toHaveLength(1);
      for (let i = 0; i < 2; i++) expect((await request("/webhooks/telegram", "POST", update(204, newTopic), undefined, config.webhookSecret)).status).toBe(200);
      expect((await store.messages(fresh.id)).map(m => m.body)).toEqual(["Fresh Bob", "Operator answer"]);
      expect((await store.messages(other.id)).map(m => m.body)).toEqual(["Keep Alice"]);
      expect(sent).toHaveLength(3);
      const visible = await (await request(`/api/conversations/${fresh.id}/messages`, "GET", undefined, fresh.token)).json() as { messages: { body: string }[] };
      expect(visible.messages.map(m => m.body)).toEqual(["Fresh Bob", "Operator answer"]);
    } finally { await store.close(); db?.close(); }
  });
}
