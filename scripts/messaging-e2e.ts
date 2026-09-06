import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { chromium, type Page } from "playwright-core";
import { createApp } from "../src/app";
import { createRuntimeHandler } from "../src/runtime";
import { Bridge } from "../src/bridge";
import { TelegramConnector } from "../src/connectors";
import { D1Store, type D1Transport } from "../src/d1-store";
import { schemaStatements } from "../src/schema";
import { secret } from "../src/store";
import type { Config } from "../src/config";

// Real browser, HTTP handlers, D1 adapter and Telegram connector. Only the
// Cloudflare database transport and Telegram network are simulated locally.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
const failures: string[] = [];
async function scenario(name: string, run: (h: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const h = await setup();
  try { await run(h); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
  finally { await h.close(); }
}
async function setup() {
  const db = new Database(":memory:");
  db.exec(`PRAGMA foreign_keys=ON; ${schemaStatements.join(";")}`);
  const transport: D1Transport = { async batch(statements) {
    return db.transaction(() => statements.map(({ sql, params = [] }) => {
      const q = db.query(sql);
      if (/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(sql)) return { results: q.all(...params) as Record<string, unknown>[] };
      const result = q.run(...params);
      return { results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
    }))();
  } };
  const store = new D1Store(transport); await store.ready();
  let runtime: ReturnType<typeof createRuntimeHandler>, queue: Promise<unknown> = Promise.resolve();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const result = queue.then(() => runtime(request)); queue = result.catch(() => {}); return result;
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  const config: Config = { host: "127.0.0.1", port: server.port!, publicUrl: origin, adminToken: secret(), dbPath: ":memory:",
    siteId: "test", siteName: "Synthetic inbox", origins: [origin], connector: "telegram", telegramToken: "123:synthetic",
    telegramChatId: "-10042", telegramOperators: ["42"], webhookSecret: secret() };
  let topic = 100, event = 1000;
  const deliveries: { topic: number; text: string }[] = [];
  const telegram = (async (url: unknown, options?: RequestInit) => {
    const data = JSON.parse(String(options?.body));
    if (String(url).endsWith("/createForumTopic")) return Response.json({ ok: true, result: { message_thread_id: ++topic } });
    assert(String(url).endsWith("/sendMessage")); deliveries.push({ topic: data.message_thread_id, text: data.text });
    return Response.json({ ok: true, result: { message_id: ++event } });
  }) as typeof fetch;
  const bridge = new Bridge(store, new TelegramConnector(config, telegram));
  runtime = createRuntimeHandler({ handler: createApp(config, bridge), bridge, useD1: true, internalToken: "" });
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  async function tab() { const context = await browser.newContext(); contexts.push(context); const page = await context.newPage(); page.setDefaultTimeout(8000); return page; }
  async function visitor(name: string, text: string) {
    const page = await tab(); await page.goto(origin); await page.getByRole("button", { name: "Open the demo", exact: true }).click();
    await sendNew(page, name, text); return page;
  }
  async function sendNew(page: Page, name: string, text: string) {
    await page.getByLabel("Your name (optional)").fill(name);
    await page.getByLabel("Message", { exact: true }).fill(text);
    await page.locator("#threadpost-widget").getByRole("button", { name: "Send", exact: true }).click();
    await page.locator('#threadpost-widget [data-message-id]').filter({ hasText: text }).waitFor();
  }
  async function session(page: Page) { return page.evaluate(() => {
    const key = Object.keys(localStorage).find(k => /^threadpost:/.test(k) && !k.includes(":read:") && !k.endsWith(":notifications"))!;
    return JSON.parse(localStorage.getItem(key)! ) as { id: string; token: string };
  }); }
  async function inbox() {
    const page = await tab(); await page.goto(origin + "/admin"); await page.getByLabel("Admin token", { exact: true }).fill(config.adminToken);
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.locator("#admin-view").waitFor(); return page;
  }
  async function reply(threadId: string, text: string, operator = 42) {
    const response = await fetch(origin + "/webhooks/telegram", { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": config.webhookSecret },
      body: JSON.stringify({ update_id: ++event, message: { chat: { id: -10042 }, from: { id: operator, is_bot: false }, message_thread_id: Number(threadId), text } }) });
    assert.equal(response.status, 200);
  }
  return { store, origin, deliveries, visitor, sendNew, session, inbox, reply, async close() { await Promise.all(contexts.map(c => c.close())); await server.stop(true); db.close(); } };
}
try {
  await scenario("1. Telegram reply polls into widget and survives reselecting the admin thread", async h => {
    const page = await h.visitor("Bob", "TEst"), s = await h.session(page), inbox = await h.inbox();
    const row = inbox.locator(`[data-id="${s.id}"]`); await row.click();
    await h.reply((await h.store.require(s.id)).threadId!, "Reply for Bob");
    await page.getByText("Reply for Bob", { exact: true }).waitFor();
    await inbox.locator("#message-list").getByText("Reply for Bob", { exact: true }).waitFor();
    await row.click();
    await inbox.locator("#message-list").getByText("TEst", { exact: true }).waitFor();
  });
  await scenario("2. Independent visitors keep separate histories and reject unauthorized replies", async h => {
    const a = await h.visitor("Alice", "Alice first"), b = await h.visitor("Bob", "Bob first");
    const sa = await h.session(a), sb = await h.session(b);
    const ta = (await h.store.require(sa.id)).threadId!, tb = (await h.store.require(sb.id)).threadId!;
    assert.notEqual(ta, tb); await h.reply(ta, "Only Alice"); await h.reply(tb, "Only Bob"); await h.reply(tb, "Unauthorized", 99);
    await a.getByText("Only Alice", { exact: true }).waitFor(); await b.getByText("Only Bob", { exact: true }).waitFor();
    assert.equal(await a.getByText("Only Bob", { exact: true }).count(), 0);
    assert.equal(await b.getByText("Only Alice", { exact: true }).count(), 0);
    assert.equal((await h.store.messages(sb.id)).some(m => m.body === "Unauthorized"), false);
    const response = await fetch(`${h.origin}/api/conversations/${sb.id}/messages`, { headers: { Authorization: `Bearer ${sa.token}` } }); assert.equal(response.status, 401);
  });
  await scenario("3. Delete and recreate uses a new ID/topic without overwriting another visitor", async h => {
    const page = await h.visitor("Bob", "Old Bob"), other = await h.visitor("Alice", "Keep Alice");
    const old = await h.session(page), alice = await h.session(other), oldTopic = (await h.store.require(old.id)).threadId;
    page.on("dialog", d => void d.accept()); await page.getByRole("button", { name: "Delete chat", exact: true }).click();
    await page.getByLabel("Your name (optional)").waitFor(); await h.sendNew(page, "Bob", "New Bob");
    const fresh = await h.session(page); assert.notEqual(old.id, fresh.id); assert.notEqual(oldTopic, (await h.store.require(fresh.id)).threadId);
    assert.equal(await h.store.conversation(old.id), null); assert.equal(await page.getByText("Old Bob", { exact: true }).count(), 0);
    assert.equal((await h.store.messages(alice.id))[0].body, "Keep Alice");
  });
  await scenario("4. Late reply to deleted Telegram topic cannot enter the replacement chat", async h => {
    const page = await h.visitor("Bob", "Before deletion"), old = await h.session(page), topic = (await h.store.require(old.id)).threadId!;
    page.on("dialog", d => void d.accept()); await page.getByRole("button", { name: "Delete chat", exact: true }).click();
    await page.getByLabel("Your name (optional)").waitFor(); await h.sendNew(page, "Bob", "Replacement");
    const fresh = await h.session(page); await h.reply(topic, "Old topic reply"); await h.reply((await h.store.require(fresh.id)).threadId!, "New topic reply");
    await page.getByText("New topic reply", { exact: true }).waitFor(); assert.equal(await page.getByText("Old topic reply", { exact: true }).count(), 0);
    assert.deepEqual((await h.store.messages(fresh.id)).map(m => m.body), ["Replacement", "New topic reply"]);
  });
  await scenario("5. Delayed admin send cannot switch back and replace the selected conversation", async h => {
    const a = await h.visitor("Alice", "Alice question"), b = await h.visitor("Bob", "Bob question");
    const sa = await h.session(a), sb = await h.session(b), inbox = await h.inbox();
    await inbox.locator(`[data-id="${sa.id}"]`).click();
    let release!: () => void, captured!: () => void;
    const gate = new Promise<void>(r => release = r), caught = new Promise<void>(r => captured = r);
    await inbox.route(`**/api/admin/conversations/${sa.id}/messages`, async route => { const response = await route.fetch(); captured(); await gate; await route.fulfill({ response }); });
    await inbox.locator("#reply").fill("Delayed Alice answer"); await inbox.locator('#reply-form button[type="submit"]').click();
    await caught; await inbox.locator(`[data-id="${sb.id}"]`).click();
    await inbox.locator("#message-list").getByText("Bob question", { exact: true }).waitFor(); release();
    await a.getByText("Delayed Alice answer", { exact: true }).waitFor(); await inbox.waitForTimeout(1000);
    assert.equal(await inbox.locator(`[data-id="${sb.id}"]`).getAttribute("aria-current"), "true");
    await inbox.locator("#message-list").getByText("Bob question", { exact: true }).waitFor();
  });
} finally { await browser.close(); }
assert.deepEqual(failures, [], `Failed scenarios: ${failures.join(", ")}`);
