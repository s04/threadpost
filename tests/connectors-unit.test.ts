import { expect, test } from "bun:test";
import { TelegramConnector, DeliveryError } from "../src/connectors";
import type { Config } from "../src/config";

const config: Config = { host: "127.0.0.1", port: 8788, publicUrl: "https://chat.example", adminToken: "a".repeat(40),
  dbPath: ":memory:", siteId: "test", siteName: "Test", origins: ["https://chat.example"], connector: "telegram",
  telegramToken: "123:synthetic-private-token", telegramChatId: "-10042", telegramOperators: ["42"], webhookSecret: "s".repeat(40) };

for (const [status, uncertain] of [[400, false], [403, false], [429, false], [500, true], [503, true]] as const) {
  test(`Telegram HTTP ${status} classifies delivery uncertainty without exposing credentials`, async () => {
    const transport = (async () => Response.json({ ok: false, description: config.telegramToken }, { status })) as unknown as typeof fetch;
    const connector = new TelegramConnector(config, transport);
    try { await connector.send("101", "Synthetic message"); throw new Error("Expected rejection"); }
    catch (error) {
      expect(error).toBeInstanceOf(DeliveryError);
      expect((error as DeliveryError).uncertain).toBe(uncertain);
      expect(String(error)).not.toContain(config.telegramToken);
    }
  });
}

test("Telegram transport and malformed JSON failures remain uncertain and redact token-bearing errors", async () => {
  for (const transport of [
    async () => { throw new Error(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`); },
    async () => new Response("not JSON"),
  ]) {
    const connector = new TelegramConnector(config, transport as unknown as typeof fetch);
    await expect(connector.send("101", "Synthetic message")).rejects.toMatchObject({ uncertain: true, message: "Delivery outcome unknown" });
  }
});

test("a malformed topic result cannot be recorded as a confirmed topic", async () => {
  for (const result of [{}, { message_thread_id: "101" }, { message_thread_id: 1.5 }]) {
    const connector = new TelegramConnector(config, (async () => Response.json({ ok: true, result })) as unknown as typeof fetch);
    await expect(connector.createThread("synthetic-conversation")).rejects.toMatchObject({ uncertain: true });
  }
});
