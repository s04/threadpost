import { beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { Bridge } from "../src/bridge";
import { type Config } from "../src/config";
import { DemoConnector } from "../src/connectors";
import { Store } from "../src/store";

const origin = "http://localhost:8788";
const config: Config = {
  host: "127.0.0.1",
  port: 8788,
  publicUrl: origin,
  adminToken: "synthetic-admin-token-32-characters-long",
  dbPath: ":memory:",
  siteId: "test-site",
  siteName: "Synthetic test site",
  origins: [origin, "https://allowed.example"],
  connector: "demo",
  telegramToken: "",
  telegramChatId: "",
  telegramOperators: [],
  webhookSecret: "",
};

type Handler = ReturnType<typeof createApp>;
let store: Store;
let bridge: Bridge;
let app: Handler;

beforeEach(() => {
  store = new Store(":memory:");
  bridge = new Bridge(store, new DemoConnector());
  app = createApp(config, bridge);
});

test("persistent admin cookies survive app restarts, expire, and revoke on logout or token rotation", async () => {
  const cookie = await login();
  app = createApp(config, new Bridge(store, new DemoConnector()));
  expect((await app(fakeRequest("/api/admin/overview", { cookie }))).status).toBe(200);
  const rotated = createApp({ ...config, adminToken: "different-synthetic-admin-token-32-characters" }, new Bridge(store, new DemoConnector()));
  expect((await rotated(fakeRequest("/api/admin/overview", { cookie }))).status).toBe(401);
  expect((await app(fakeRequest("/api/admin/logout", { method: "POST", cookie }))).status).toBe(200);
  app = createApp(config, new Bridge(store, new DemoConnector()));
  expect((await app(fakeRequest("/api/admin/overview", { cookie }))).status).toBe(401);
  const next = await login();
  store.db.query("UPDATE admin_sessions SET expires_at=?").run(Date.now() - 1);
  expect((await app(fakeRequest("/api/admin/overview", { cookie: next }))).status).toBe(401);
});

function fakeRequest(path: string, options: {
  method?: string;
  body?: unknown;
  rawBody?: string;
  token?: string;
  cookie?: string;
  origin?: string | null;
} = {}) {
  const headers = new Headers();
  const method = options.method || "GET";
  if (options.body !== undefined || options.rawBody !== undefined) headers.set("Content-Type", "application/json");
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.origin !== null) headers.set("Origin", options.origin || origin);
  return new Request(`${origin}${path}`, {
    method,
    headers,
    body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
}

async function json(response: Response): Promise<any> {
  return response.json();
}

async function createConversation(name = "Test visitor") {
  const response = await app(fakeRequest("/api/conversations", {
    method: "POST",
    body: { siteId: config.siteId, name },
    origin: "https://allowed.example",
  }));
  expect(response.status).toBe(201);
  return json(response) as Promise<{ id: string; token: string; status: "open" }>;
}

async function login() {
  const response = await app(fakeRequest("/api/admin/login", {
    method: "POST",
    body: { token: config.adminToken },
  }));
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).toContain("Max-Age=2592000");
  return setCookie!.split(";", 1)[0];
}

describe("admin authentication and request origin", () => {
  test("admin endpoints require a session, login sets a protected cookie, and logout invalidates it", async () => {
    expect((await app(fakeRequest("/api/admin/overview", { origin: null }))).status).toBe(401);

    const cookie = await login();
    expect((await app(fakeRequest("/api/admin/overview", { cookie, origin: null }))).status).toBe(200);

    const logout = await app(fakeRequest("/api/admin/logout", { method: "POST", cookie }));
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await app(fakeRequest("/api/admin/overview", { cookie, origin: null }))).status).toBe(401);
  });

  test("cross-origin login and authenticated mutation are denied", async () => {
    const rejectedLogin = await app(fakeRequest("/api/admin/login", {
      method: "POST",
      body: { token: config.adminToken },
      origin: "https://attacker.example",
    }));
    expect(rejectedLogin.status).toBe(403);

    const cookie = await login();
    const conversation = await createConversation();
    const rejectedMutation = await app(fakeRequest(`/api/admin/conversations/${conversation.id}`, {
      method: "PATCH",
      body: { status: "closed" },
      cookie,
      origin: "https://attacker.example",
    }));
    expect(rejectedMutation.status).toBe(403);
    expect(store.require(conversation.id).status).toBe("open");
  });
});

describe("visitor isolation and validation", () => {
  test("one visitor token cannot read or write another conversation", async () => {
    const visitorA = await createConversation("Visitor A");
    const visitorB = await createConversation("Visitor B");

    const read = await app(fakeRequest(`/api/conversations/${visitorB.id}/messages`, {
      token: visitorA.token,
      origin: "https://allowed.example",
    }));
    expect(read.status).toBe(401);

    const write = await app(fakeRequest(`/api/conversations/${visitorB.id}/messages`, {
      method: "POST",
      token: visitorA.token,
      body: { body: "Cross-conversation write", clientMessageId: "message-a1" },
      origin: "https://allowed.example",
    }));
    expect(write.status).toBe(401);
    expect(store.messages(visitorB.id)).toHaveLength(0);
  });

  test("disallowed widget origins are rejected without CORS permission", async () => {
    const response = await app(fakeRequest("/api/conversations", {
      method: "POST",
      body: { siteId: config.siteId },
      origin: "https://attacker.example",
    }));
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("message and request-size limits are enforced", async () => {
    const visitor = await createConversation();
    const longMessage = await app(fakeRequest(`/api/conversations/${visitor.id}/messages`, {
      method: "POST",
      token: visitor.token,
      body: { body: "x".repeat(2001), clientMessageId: "message-long" },
      origin: "https://allowed.example",
    }));
    expect(longMessage.status).toBe(400);

    const oversizedRequest = await app(fakeRequest(`/api/conversations/${visitor.id}/messages`, {
      method: "POST",
      token: visitor.token,
      rawBody: JSON.stringify({ body: "x", clientMessageId: "message-large", padding: "x".repeat(17_000) }),
      origin: "https://allowed.example",
    }));
    expect(oversizedRequest.status).toBe(413);
  });

  test("reusing a client message ID is idempotent and rejects changed text", async () => {
    const visitor = await createConversation();
    const path = `/api/conversations/${visitor.id}/messages`;
    const first = await app(fakeRequest(path, {
      method: "POST", token: visitor.token,
      body: { body: "Same message", clientMessageId: "stable-message-id" },
      origin: "https://allowed.example",
    }));
    const duplicate = await app(fakeRequest(path, {
      method: "POST", token: visitor.token,
      body: { body: "Same message", clientMessageId: "stable-message-id" },
      origin: "https://allowed.example",
    }));
    expect((await json(duplicate)).id).toBe((await json(first)).id);
    expect(store.messages(visitor.id)).toHaveLength(1);

    const conflict = await app(fakeRequest(path, {
      method: "POST", token: visitor.token,
      body: { body: "Changed message", clientMessageId: "stable-message-id" },
      origin: "https://allowed.example",
    }));
    expect(conflict.status).toBe(409);
  });
});

describe("admin-to-visitor messages and delivery recovery", () => {
  test("an admin reply is visible when the visitor polls", async () => {
    const visitor = await createConversation("Reply recipient");
    const cookie = await login();
    const reply = await app(fakeRequest(`/api/admin/conversations/${visitor.id}/messages`, {
      method: "POST",
      cookie,
      body: { body: "Public operator reply", clientMessageId: "admin-reply-1" },
    }));
    expect(reply.status).toBe(200);

    const poll = await app(fakeRequest(`/api/conversations/${visitor.id}/messages`, {
      token: visitor.token,
      origin: "https://allowed.example",
    }));
    const result = await json(poll);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      direction: "outbound",
      body: "Public operator reply",
      deliveryStatus: "sent",
    });
  });

  test("only failed or unknown delivery can be retried and each retry returns to pending", async () => {
    const visitor = await createConversation();
    const cookie = await login();
    const message = store.add(visitor.id, "inbound", "Deliver this", "delivery-test-1");

    for (const status of ["failed", "unknown"] as const) {
      store.delivery(message.id, status);
      const retry = await app(fakeRequest(`/api/admin/messages/${message.id}/retry`, {
        method: "POST",
        cookie,
      }));
      expect(retry.status).toBe(200);
      expect((await json(retry)).deliveryStatus).toBe("pending");

      const duplicateRetry = await app(fakeRequest(`/api/admin/messages/${message.id}/retry`, {
        method: "POST",
        cookie,
      }));
      expect(duplicateRetry.status).toBe(409);
    }
  });
});
