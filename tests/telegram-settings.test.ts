import { afterEach, describe, expect, test } from "bun:test";
import { Bridge } from "../src/bridge";
import type { Config } from "../src/config";
import { DemoConnector, TelegramConnector } from "../src/connectors";
import { Store } from "../src/store";
import { TelegramSettings } from "../src/telegram-settings";
import { createApp } from "../src/app";

const config = (): Config => ({ host: "127.0.0.1", port: 8788, publicUrl: "https://chat.example",
  adminToken: "a".repeat(40), dbPath: ":memory:", siteId: "test", siteName: "Test", origins: ["https://chat.example"],
  connector: "demo", telegramToken: "", telegramChatId: "", telegramOperators: [], webhookSecret: "" });
const key = "synthetic-settings-key-that-is-long-enough";
const databases: Store[] = [];
afterEach(() => { while (databases.length) databases.pop()!.close(); });

function telegramMock(calls: { method: string; payload: any }[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const payload = JSON.parse(String(init?.body)); calls.push({ method, payload });
    const result: Record<string, unknown> = {
      getMe: { id: 123, is_bot: true, username: "synthetic_bot" },
      getChat: { id: -10042, type: "supergroup", is_forum: true },
      getChatMember: { status: "administrator", can_manage_topics: true },
      getWebhookInfo: { url: "" }, setWebhook: true,
    }[method] as Record<string, unknown>;
    return Response.json({ ok: true, result });
  }) as typeof fetch;
}

describe("TelegramSettings", () => {
  test("reports the failed setup step without exposing provider errors or credentials", async () => {
    for (const failedMethod of ["getMe", "getChat"]) {
      const store = new Store(":memory:"); databases.push(store);
      const transport = (async (url: string | URL | Request) => {
        const method = String(url).split("/").pop();
        return method === failedMethod
          ? Response.json({ ok: false, description: "sensitive provider detail 123:synthetic-token" }, { status: 400 })
          : Response.json({ ok: true, result: { id: 123, is_bot: true, username: "synthetic_bot" } });
      }) as typeof fetch;
      const service = new TelegramSettings(config(), new Bridge(store, new DemoConnector()), key, transport);
      try {
        await service.connect({ botToken: "123:synthetic-token", chatId: "-10042", operatorIds: ["7"] });
        throw new Error("Expected rejection");
      } catch (error) {
        expect(String(error)).toContain(failedMethod === "getMe" ? "BotFather" : "-100 chat ID");
        expect(String(error)).not.toContain("synthetic-token");
        expect(String(error)).not.toContain("sensitive provider detail");
      }
    }
  });
  test("verifies Telegram, encrypts credentials, and resets demo thread mappings once", async () => {
    const store = new Store(":memory:"); databases.push(store);
    const visitor = store.create("Visitor"); store.add(visitor.id, "outbound", "history", "historic-one");
    store.thread(visitor.id, "sent", "demo-thread");
    const cfg = config(), bridge = new Bridge(store, new DemoConnector()), calls: { method: string; payload: any }[] = [];
    const settings = new TelegramSettings(cfg, bridge, key, telegramMock(calls));
    const status = await settings.connect({ botToken: "123:synthetic-token", chatId: "-10042", operatorIds: ["7", "7", "8"] });
    expect(status).toEqual({ connected: true, botUsername: "synthetic_bot", chatId: "-10042", operatorIds: ["7", "8"] });
    expect(calls.map(call => call.method)).toEqual(["getMe", "getChat", "getChatMember", "getWebhookInfo", "setWebhook"]);
    expect(calls.at(-1)!.payload).toMatchObject({ url: "https://chat.example/webhooks/telegram" });
    expect(calls.at(-1)!.payload.secret_token).toHaveLength(43);
    const encrypted = store.getSetting("telegram_config")!;
    expect(encrypted.startsWith("v1.")).toBe(true); expect(encrypted).not.toContain("synthetic-token");
    expect(store.conversation(visitor.id)?.threadId).toBeNull();
    expect(store.conversation(visitor.id)?.threadState).toBe("pending");
    expect(store.messages(visitor.id).map(message => message.body)).toEqual(["history"]);
    expect(cfg.telegramToken).toBe("123:synthetic-token"); expect(bridge.connector).toBeInstanceOf(TelegramConnector);
  });

  test("rejects a public Telegram group before configuring its webhook or saving credentials", async () => {
    const store = new Store(":memory:"); databases.push(store);
    const calls: { method: string; payload: any }[] = [];
    const transport = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      calls.push({ method, payload: JSON.parse(String(init?.body)) });
      const result = method === "getMe"
        ? { id: 123, is_bot: true, username: "synthetic_bot" }
        : { id: -10042, type: "supergroup", is_forum: true, username: "public_group" };
      return Response.json({ ok: true, result });
    }) as typeof fetch;
    const service = new TelegramSettings(config(), new Bridge(store, new DemoConnector()), key, transport);
    await expect(service.connect({ botToken: "123:synthetic-token", chatId: "-10042", operatorIds: ["7"] }))
      .rejects.toMatchObject({ status: 400, message: "Use a private Telegram group without a public username." });
    expect(calls.map(call => call.method)).toEqual(["getMe", "getChat"]);
    expect(calls.some(call => call.method === "setWebhook")).toBe(false);
    expect(store.getSetting("telegram_config")).toBeNull();
  });

  test("loads persisted credentials without network access and refuses rerouting", async () => {
    const store = new Store(":memory:"); databases.push(store);
    const firstConfig = config(), firstBridge = new Bridge(store, new DemoConnector());
    await new TelegramSettings(firstConfig, firstBridge, key, telegramMock([])).connect({
      botToken: "123:synthetic-token", chatId: "-10042", operatorIds: ["7"],
    });
    const cfg = config(), bridge = new Bridge(store, new DemoConnector()); let fetched = false;
    const noNetwork = (async () => { fetched = true; throw new Error("network must not be used"); }) as unknown as typeof fetch;
    const loaded = new TelegramSettings(cfg, bridge, key, noNetwork); await loaded.load();
    expect(fetched).toBe(false);
    expect(loaded.status()).toEqual({ connected: true, botUsername: "synthetic_bot", chatId: "-10042", operatorIds: ["7"] });
    expect(cfg.connector).toBe("telegram"); expect(bridge.connector).toBeInstanceOf(TelegramConnector);
    await expect(loaded.connect({ botToken: "456:different", chatId: "-10099", operatorIds: ["7"] }))
      .rejects.toMatchObject({ status: 409 });
    expect(fetched).toBe(false);
  });

  test("fails startup closed when the encryption key changed", async () => {
    const store = new Store(":memory:"); databases.push(store);
    await new TelegramSettings(config(), new Bridge(store, new DemoConnector()), key, telegramMock([])).connect({
      botToken: "123:synthetic-token", chatId: "-10042", operatorIds: ["7"],
    });
    const restarted = new TelegramSettings(config(), new Bridge(store, new DemoConnector()), "different-settings-key-that-is-long-enough");
    await expect(restarted.load()).rejects.toThrow("Restore the original SETTINGS_KEY");
    expect(restarted.status()).toEqual({ connected: false, error: "Stored Telegram configuration could not be loaded." });
  });

  test("reports Telegram configured by the environment without exposing credentials", () => {
    const store = new Store(":memory:"); databases.push(store);
    const cfg = config(); cfg.connector = "telegram"; cfg.telegramToken = "123:environment-secret";
    cfg.telegramChatId = "-10042"; cfg.telegramOperators = ["7"];
    const status = new TelegramSettings(cfg, new Bridge(store, new TelegramConnector(cfg)), key).status();
    expect(status).toEqual({ connected: true, chatId: "-10042", operatorIds: ["7"] });
    expect(JSON.stringify(status)).not.toContain("environment-secret");
  });

  test("connect route requires an authenticated same-origin operator and survives restart with a stable workspace", async () => {
    const store = new Store(":memory:"); databases.push(store);
    const cfg = config(), bridge = new Bridge(store, new DemoConnector()), calls: { method: string; payload: any }[] = [];
    const telegram = new TelegramSettings(cfg, bridge, key, telegramMock(calls));
    const workspaceBinding = "test:original-workspace";
    const app = createApp(cfg, bridge, { telegram, workspaceBinding });
    const visitor = store.create("Visitor"); store.add(visitor.id, "outbound", "kept history", "history-one");
    const connectBody = JSON.stringify({ botToken: "123:synthetic-token", chatId: "-10042", operatorIds: ["7"] });
    const post = (cookie?: string, origin = cfg.publicUrl) => app(new Request(`${cfg.publicUrl}/api/admin/telegram`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: connectBody,
    }));
    expect((await post()).status).toBe(401);
    const login = await app(new Request(`${cfg.publicUrl}/api/admin/login`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: cfg.publicUrl }, body: JSON.stringify({ token: cfg.adminToken }) }));
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    expect((await post(cookie, "https://evil.example")).status).toBe(403);
    const connected = await post(cookie); expect(connected.status).toBe(200);
    expect(await connected.json()).toEqual({ connected: true, botUsername: "synthetic_bot", chatId: "-10042", operatorIds: ["7"] });

    const restartedConfig = config(), restartedBridge = new Bridge(store, new DemoConnector());
    const restartedSettings = new TelegramSettings(restartedConfig, restartedBridge, key, telegramMock([]));
    await restartedSettings.load();
    const restartedApp = createApp(restartedConfig, restartedBridge, { telegram: restartedSettings, workspaceBinding });
    const messages = await restartedApp(new Request(`${restartedConfig.publicUrl}/api/conversations/${visitor.id}/messages`, {
      headers: { Authorization: `Bearer ${visitor.token}` },
    }));
    expect(messages.status).toBe(200);
    expect((await messages.json() as any).messages.map((message: any) => message.body)).toEqual(["kept history"]);
  });

  test("rejects connection while delivery state is unresolved", async () => {
    const store = new Store(":memory:"); databases.push(store);
    const visitor = store.create("Visitor"); store.add(visitor.id, "inbound", "waiting", "pending-one");
    const calls: { method: string; payload: any }[] = [];
    const service = new TelegramSettings(config(), new Bridge(store, new DemoConnector()), key, telegramMock(calls));
    await expect(service.connect({ botToken: "123:synthetic-token", chatId: "-10042", operatorIds: ["7"] }))
      .rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(0);
  });
});
