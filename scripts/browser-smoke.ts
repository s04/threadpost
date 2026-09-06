import { strict as assert } from "node:assert";
import { chromium } from "playwright-core";
import { createApp } from "../src/app";
import { Bridge } from "../src/bridge";
import { DemoConnector } from "../src/connectors";
import { Store, secret } from "../src/store";
import type { Config } from "../src/config";

// An isolated in-memory demo: never reads deployment credentials or calls Telegram.
const store = new Store(":memory:");
let handler: ReturnType<typeof createApp>;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => handler(request, "browser-smoke") });
const origin = `http://127.0.0.1:${server.port}`;
const config: Config = {
  host: "127.0.0.1", port: server.port!, publicUrl: origin, adminToken: secret(),
  dbPath: ":memory:", siteId: "demo", siteName: "Browser test", origins: [origin],
  connector: "demo", telegramToken: "", telegramChatId: "", telegramOperators: [], webhookSecret: "",
};
handler = createApp(config, new Bridge(store, new DemoConnector()));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  const visitor = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const operator = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await visitor.newPage(), inbox = await operator.newPage();
  const errors: string[] = [];
  for (const tab of [page, inbox]) {
    tab.on("pageerror", () => errors.push("Browser JavaScript error"));
    tab.on("console", message => {
      if (/violates.*content security policy/i.test(message.text())) errors.push("CSP violation");
    });
  }
  await inbox.goto(`${origin}/admin`);
  assert.equal(await inbox.getByRole("checkbox", { name: "Keep me signed in for 30 days" }).isChecked(), false);
  await inbox.getByLabel("Admin token", { exact: true }).fill(config.adminToken);
  await inbox.getByRole("button", { name: "Sign in", exact: true }).click();
  await inbox.locator("#settings-button").waitFor();
  const session = (await operator.cookies()).find(cookie => cookie.name === "threadpost_session");
  assert(session?.httpOnly && session.sameSite === "Strict");
  assert(session.expires > Date.now() / 1000 + 28_700 && session.expires <= Date.now() / 1000 + 28_800);

  await page.goto(origin);
  await page.getByRole("button", { name: "Open the demo", exact: true }).click();
  await page.getByLabel("Your name (optional)").fill("Synthetic visitor");
  await page.getByLabel("Message", { exact: true }).fill("Does automatic messaging work?");
  await page.locator("#threadpost-widget").getByRole("button", { name: "Send", exact: true }).click();
  const thread = inbox.getByRole("button").filter({ hasText: "Synthetic visitor" }).first();
  await thread.waitFor({ timeout: 15_000 }); await thread.click();
  await inbox.locator("#reply").fill("Yes, without refreshing.");
  await inbox.locator('#reply-form button[type="submit"]').click();
  await page.getByText("Yes, without refreshing.", { exact: true }).waitFor({ timeout: 15_000 });
  const conversation = store.list()[0] as { id: string };
  await inbox.goto(`${origin}/admin?conversation=${conversation.id}`);
  await inbox.locator("#message-list").getByText("Does automatic messaging work?", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

  await inbox.locator("#block-button").click();
  await inbox.locator("#confirm-action").click();
  await page.getByText("This conversation has been blocked.", { exact: true }).waitFor({ timeout: 15_000 });
  await inbox.locator("#block-button").click();
  await page.getByLabel("Message", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  page.on("dialog", dialog => void dialog.accept());
  await page.getByRole("button", { name: "Delete chat", exact: true }).click();
  await page.getByLabel("Your name (optional)").waitFor({ state: "visible" });
  await inbox.locator("#empty-thread").waitFor({ state: "visible", timeout: 15_000 });
  await inbox.locator("#logout-button").click();
  await inbox.getByLabel("Admin token", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Browser smoke passed: login, demo CTA, automatic replies, blocking, deletion, mobile fit, and CSP.");
} finally {
  await browser?.close();
  await server.stop(true);
  store.close();
}
