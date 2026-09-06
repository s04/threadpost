import { describe, expect, test } from "bun:test";
import { createRuntimeHandler } from "../src/runtime";

const token = "synthetic-internal-token-32-characters-long";
const request = (headers: Record<string, string> = {}, method = "POST") =>
  new Request("https://chat.example/api/conversations", { method, headers });

describe("container runtime handler", () => {
  test("rejects direct requests without the private header", async () => {
    let handled = false, flushed = false;
    const runtime = createRuntimeHandler({
      internalToken: token, useD1: true,
      handler: async () => { handled = true; return new Response("committed"); },
      bridge: { flush: async () => { flushed = true; } },
    });
    const response = await runtime(request());
    expect(response.status).toBe(404);
    expect(handled).toBe(false); expect(flushed).toBe(false);
  });

  test("awaits flushing but preserves a committed response when flushing fails", async () => {
    let committed = false, logged = 0, releaseFlush!: () => void;
    const flushGate = new Promise<void>(resolve => { releaseFlush = resolve; });
    const runtime = createRuntimeHandler({
      internalToken: token, useD1: true,
      handler: async (_request, ip) => { committed = true; return Response.json({ committed, ip }, { status: 201 }); },
      bridge: { flush: async () => { await flushGate; throw new Error("synthetic secret-bearing failure"); } },
      onFlushError: () => { logged++; },
    });
    let settled = false;
    const pending = runtime(request({
      "x-threadpost-internal": token,
      "x-threadpost-client-ip": "203.0.113.7",
    })).finally(() => { settled = true; });
    await Promise.resolve();
    expect(committed).toBe(true); expect(settled).toBe(false);
    releaseFlush();
    const response = await pending;
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ committed: true, ip: "203.0.113.7" });
    expect(logged).toBe(1);
  });

  test("does not flush preflight requests", async () => {
    let flushed = false;
    const runtime = createRuntimeHandler({
      internalToken: token, useD1: true,
      handler: async () => new Response(null, { status: 204 }),
      bridge: { flush: async () => { flushed = true; } },
    });
    const response = await runtime(request({ "x-threadpost-internal": token }, "OPTIONS"));
    expect(response.status).toBe(204); expect(flushed).toBe(false);
  });
});
