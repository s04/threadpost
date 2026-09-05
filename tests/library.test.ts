import { test, expect } from "bun:test";
import { Bridge, Store } from "threadpost";
import type { Connector, OperatorReply } from "threadpost/connectors";

test("a custom connector sends and receives through the public library entry points", async () => {
  const deliveries: string[] = [];
  const adapter: Connector = {
    kind: "custom", async createThread(id) { return `custom:${id}`; },
    async send(_thread, body) { deliveries.push(body); },
  };
  const store = new Store(":memory:");
  try {
    const bridge = new Bridge(store, adapter), conversation = store.create("Visitor");
    store.add(conversation.id, "inbound", "Question", "question-one");
    await bridge.flush();
    expect(deliveries).toEqual(["Question"]);
    const reply: OperatorReply = { eventId: "provider-event-1", threadId: `custom:${conversation.id}`, body: "Answer" };
    expect(bridge.receive(reply)).toBe(true);
    expect(bridge.receive(reply)).toBe(false);
    expect(bridge.receive({ ...reply, eventId: "other", threadId: "unmapped-thread" })).toBe(false);
    expect(store.messages(conversation.id).map(message => message.body)).toEqual(["Question", "Answer"]);
  } finally { store.db.close(); }
});
