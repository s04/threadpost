import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bridge } from "../src/bridge";
import { DeliveryError, TelegramConnector, type Connector } from "../src/connectors";
import type { Config } from "../src/config";
import { AppError, Store } from "../src/store";

const config: Config = {
  host: "127.0.0.1",
  port: 8788,
  publicUrl: "http://localhost:8788",
  adminToken: "a".repeat(32),
  dbPath: ":memory:",
  siteId: "demo",
  siteName: "Demo site",
  origins: ["http://localhost:8788"],
  connector: "telegram",
  telegramToken: "123456:token_value",
  telegramChatId: "-1001234567890",
  telegramOperators: ["42"],
  webhookSecret: "w".repeat(32),
};

const stores: Store[] = [];
const temporaryDirectories: string[] = [];

function store(path = ":memory:") {
  const value = new Store(path);
  stores.push(value);
  return value;
}

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "threadpost-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "threadpost.sqlite");
}

afterEach(() => {
  for (const value of stores.splice(0)) {
    try { value.db.close(); } catch { /* already closed by a durability test */ }
  }
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Store", () => {
  test("conversation tokens are isolated", () => {
    const database = store();
    const first = database.create("First");
    const second = database.create("Second");

    expect(database.authenticate(first.id, first.token).id).toBe(first.id);
    expect(() => database.authenticate(first.id, second.token)).toThrow(AppError);
    expect(() => database.authenticate(second.id, first.token)).toThrow(AppError);
  });

  test("message IDs are idempotent and conflicting text is rejected", () => {
    const database = store();
    const conversation = database.create("Visitor");
    const first = database.add(conversation.id, "inbound", "Hello", "client-message-1");
    const repeated = database.add(conversation.id, "inbound", "Hello", "client-message-1");

    expect(repeated.id).toBe(first.id);
    expect(database.messages(conversation.id)).toHaveLength(1);
    expect(() => database.add(conversation.id, "inbound", "Changed", "client-message-1"))
      .toThrow("already used for different text");
  });
});

describe("Bridge delivery", () => {
  test.each([
    ["failed", new DeliveryError(false)],
    ["unknown", new DeliveryError(true)],
  ] as const)("persists %s delivery and does not retry automatically", async (expected, failure) => {
    const path = temporaryDatabase();
    const database = store(path);
    const conversation = database.create("Visitor");
    const message = database.add(conversation.id, "inbound", "Hello", "client-message-2");
    let calls = 0;
    const connector: Connector = {
      kind: "test",
      async createThread() { calls += 1; throw failure; },
      async send() { throw new Error("send must not be reached"); },
    };
    const bridge = new Bridge(database, connector);

    await bridge.flush();
    expect(database.message(message.id)?.deliveryStatus).toBe(expected);
    expect(calls).toBe(1);
    await bridge.flush();
    expect(calls).toBe(1);

    database.db.close();
    const reopened = store(path);
    const restartedBridge = new Bridge(reopened, connector);
    expect(reopened.message(message.id)?.deliveryStatus).toBe(expected);
    await restartedBridge.flush();
    expect(calls).toBe(1);
  });

  test("Telegram ok:false is failed and a transport timeout is unknown", async () => {
    const rejectionFetch = (async () => Response.json({ ok: false, description: "denied" })) as unknown as typeof fetch;
    const timeoutFetch = (async () => { throw new DOMException("timed out", "TimeoutError"); }) as unknown as typeof fetch;

    for (const [transport, expected] of [[rejectionFetch, "failed"], [timeoutFetch, "unknown"]] as const) {
      const database = store();
      const conversation = database.create("Visitor");
      const message = database.add(conversation.id, "inbound", "Hello", `telegram-${expected}`);
      const bridge = new Bridge(database, new TelegramConnector(config, transport));

      await bridge.flush();
      expect(database.message(message.id)?.deliveryStatus).toBe(expected);
      expect(database.require(conversation.id).threadState).toBe(expected);
    }
  });
});

describe("Telegram webhook updates", () => {
  function fixture() {
    const database = store();
    const conversation = database.create("Visitor");
    database.thread(conversation.id, "sent", "77");
    return { database, conversation, bridge: new Bridge(database, {
      kind: "unused", async createThread() { return "77"; }, async send() {},
    }) };
  }

  function update(overrides: Record<string, unknown> = {}) {
    return {
      update_id: 9001,
      message: {
        chat: { id: Number(config.telegramChatId) },
        from: { id: 42, is_bot: false },
        message_thread_id: 77,
        text: "Operator reply",
        ...overrides,
      },
    };
  }

  test.each([
    ["wrong group", { chat: { id: -999 } }],
    ["wrong operator", { from: { id: 99, is_bot: false } }],
    ["bot sender", { from: { id: 42, is_bot: true } }],
    ["command", { text: "/close" }],
  ])("ignores %s messages", (_label, overrides) => {
    const { database, conversation, bridge } = fixture();
    bridge.telegram(update(overrides), config);
    expect(database.messages(conversation.id)).toHaveLength(0);
  });

  test("processes a duplicate update exactly once", () => {
    const { database, conversation, bridge } = fixture();
    const incoming = update();

    bridge.telegram(incoming, config);
    bridge.telegram(incoming, config);

    const messages = database.messages(conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      direction: "outbound",
      body: "Operator reply",
      clientMessageId: "telegram-9001",
      deliveryStatus: "sent",
    });
  });
});
