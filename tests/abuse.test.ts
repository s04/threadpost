import { expect, test } from "bun:test";
import { verifyHuman } from "../src/abuse";
import { readConfig } from "../src/config";

const config = readConfig({ ADMIN_TOKEN: "synthetic-admin-value-at-least-32-characters", PUBLIC_URL: "https://chat.example.com",
  ALLOWED_ORIGINS: "https://site.example.com", TURNSTILE_SITE_KEY: "synthetic-site-key", TURNSTILE_SECRET_KEY: "synthetic-private-key" });

test("configuration rejects plaintext non-local embedding origins", () => {
  const base = { ADMIN_TOKEN: "synthetic-admin-value-at-least-32-characters", PUBLIC_URL: "https://chat.example.com" };
  expect(() => readConfig({ ...base, ALLOWED_ORIGINS: "http://site.example.com" })).toThrow("must use HTTPS");
  expect(readConfig({ ...base, ALLOWED_ORIGINS: "http://localhost:3000,http://127.0.0.1:3001" }).origins)
    .toEqual(["https://chat.example.com", "http://localhost:3000", "http://127.0.0.1:3001"]);
});

test("human verification checks the provider result, exact hostname and action", async () => {
  let result = { success: true, hostname: "site.example.com", action: "start_chat" };
  const transport = (async (_url: unknown, init: RequestInit) => {
    const sent = JSON.parse(String(init.body));
    expect(sent.secret).toBe(config.turnstileSecret);
    return Response.json(result);
  }) as unknown as typeof fetch;
  await verifyHuman(config, "synthetic-proof", "https://site.example.com", "192.0.2.1", transport);
  result = { ...result, hostname: "other.example.com" };
  await expect(verifyHuman(config, "proof", "https://site.example.com", "192.0.2.1", transport)).rejects.toMatchObject({ status: 403 });
  result = { ...result, hostname: "site.example.com", action: "different_form" };
  await expect(verifyHuman(config, "proof", "https://site.example.com", "192.0.2.1", transport)).rejects.toMatchObject({ status: 403 });
  result = { ...result, action: "start_chat", success: false };
  await expect(verifyHuman(config, "proof", "https://site.example.com", "192.0.2.1", transport)).rejects.toMatchObject({ status: 403 });
});

test("verification fails closed without a token or when the provider is unavailable", async () => {
  let called = false;
  const failing = (async () => { called = true; throw new Error("synthetic transport failure"); }) as unknown as typeof fetch;
  await expect(verifyHuman(config, undefined, "https://site.example.com", "192.0.2.1", failing)).rejects.toMatchObject({ status: 403 });
  expect(called).toBe(false);
  await expect(verifyHuman(config, "proof", "https://site.example.com", "192.0.2.1", failing)).rejects.toMatchObject({ status: 503 });
});
