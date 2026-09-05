import { test, expect } from "bun:test";
import { Store, secret } from "../src/store";
import { Bridge } from "../src/bridge";
import { DeliveryError, type Connector } from "../src/connectors";

test("a lost create response can be retried with the same client secret", () => {
  const store = new Store(":memory:");
  try {
    const token = secret();
    const first = store.create("Visitor", token), retry = store.create("Visitor", token);
    expect(retry).toEqual(first);
    expect(store.list()).toHaveLength(1);
    expect(store.authenticate(first.id, token).id).toBe(first.id);
  } finally { store.db.close(); }
});

test("a database cannot be rebound to another site or connector", () => {
  const store = new Store(":memory:");
  try {
    store.bindWorkspace("site:demo"); store.bindWorkspace("site:demo");
    expect(() => store.bindWorkspace("other:telegram")).toThrow("different site or connector");
  } finally { store.db.close(); }
});

test("an uncertain earlier send holds later messages until explicitly retried", async () => {
  const store = new Store(":memory:");
  try {
    const conversation = store.create("Visitor"), delivered: string[] = [];
    let fail = true;
    const connector: Connector = { kind: "test", async createThread() { return "123"; }, async send(_id, body) {
      if (fail) throw new DeliveryError(true); delivered.push(body);
    } };
    const bridge = new Bridge(store, connector);
    const first = store.add(conversation.id, "inbound", "first", "message-one");
    store.add(conversation.id, "inbound", "second", "message-two");
    await bridge.flush(); await bridge.flush();
    expect(delivered).toEqual([]);
    expect(store.messages(conversation.id).map(m => m.deliveryStatus)).toEqual(["unknown", "pending"]);
    fail = false; bridge.retry(first.id); await bridge.flush(); await bridge.flush();
    expect(delivered).toEqual(["first", "second"]);
  } finally { store.db.close(); }
});
