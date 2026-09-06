import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { D1Store, type D1Statement } from "../src/d1-store";
import { AppError } from "../src/store";
import { SQLiteD1Transport } from "./support/sqlite-d1";


const databases: Database[] = [];
function setup() {
  const db = new Database(":memory:", { strict: true }); databases.push(db);
  const transport = new SQLiteD1Transport(db);
  return { db, transport, store: new D1Store(transport) };
}
afterEach(() => { while (databases.length) databases.pop()!.close(); });

describe("D1Store", () => {
  test("admin sessions persist across restarts with expiration, revocation, and bounded storage", async () => {
    const { transport, store } = setup();
    expect(await store.createAdminSession("hash-only", 2000, 1000)).toBe(true);
    const restarted = new D1Store(transport); await restarted.ready();
    expect(await restarted.validAdminSession("hash-only", 1999)).toBe(true);
    expect(await restarted.validAdminSession("hash-only", 2000)).toBe(false);
    await restarted.deleteAdminSession("hash-only");
    expect(await store.validAdminSession("hash-only", 1001)).toBe(false);
    for (let i = 0; i < 100; i++) expect(await store.createAdminSession(`hash-${i}`, 2000, 1000)).toBe(true);
    expect(await store.createAdminSession("overflow", 3000, 1000)).toBe(false);
    expect(await store.createAdminSession("after-expiry", 3000, 2000)).toBe(true);
  });
  test("persists attribution, blocking, inbound watermarks, and quotas", async () => {
    const { transport, store } = setup(); await store.ready();
    const conversation = await store.create("Visitor", undefined, { origin: "https://site.example", path: "/contact",
      referrerOrigin: "https://search.example", browserLanguage: "en-GB", browserTimezone: "Europe/London" });
    const inbound = await store.add(conversation.id, "inbound", "hello", "source-message");
    expect(await store.firstInboundId(conversation.id)).toBe(inbound.id);
    expect((await store.findMessage(conversation.id, "inbound", "source-message"))?.id).toBe(inbound.id);
    expect(await store.findMessage(conversation.id, "outbound", "source-message")).toBeNull();
    expect((await store.list())[0]).toMatchObject({ sourceOrigin: "https://site.example", sourcePath: "/contact", lastInboundId: inbound.id, blocked: false });
    expect((await store.findByToken(conversation.token))?.id).toBe(conversation.id);
    expect(await store.conversation(conversation.id)).toMatchObject({ referrerOrigin: "https://search.example",
      browserLanguage: "en-GB", browserTimezone: "Europe/London" });
    expect((await store.setBlocked(conversation.id, true)).blocked).toBe(true);
    await expect(store.add(conversation.id, "inbound", "blocked", "blocked-message")).rejects.toMatchObject({ status: 403 });
    expect(await store.consumeQuota("message:synthetic-hash", 1, 1000, 100)).toBe(true);
    const restarted = new D1Store(transport);
    expect(await restarted.consumeQuota("message:synthetic-hash", 1, 1000, 200)).toBe(false);
    expect(await restarted.consumeQuota("message:synthetic-hash", 1, 1000, 1101)).toBe(true);
  });

  test("does not return blocked conversations from the pending outbox", async () => {
    const { store } = setup(); await store.ready();
    const blocked = await store.create("Blocked"), visible = await store.create("Visible");
    await store.add(blocked.id, "inbound", "blocked pending", "blocked-pending");
    const visibleMessage = await store.add(visible.id, "inbound", "visible pending", "visible-pending");
    await store.setBlocked(blocked.id, true);
    expect((await store.pending()).map(message => message.id)).toEqual([visibleMessage.id]);
  });

  test("isolates tokens and preserves message idempotency", async () => {
    const { store } = setup(); await store.ready(); await store.bindWorkspace("site:demo");
    const first = await store.create("First"), second = await store.create("Second");
    expect((await store.authenticate(first.id, first.token)).id).toBe(first.id);
    await expect(store.authenticate(first.id, second.token)).rejects.toMatchObject({ status: 401 });
    const inserted = await store.add(first.id, "inbound", "hello", "message-one");
    expect((await store.add(first.id, "inbound", "hello", "message-one")).id).toBe(inserted.id);
    await expect(store.add(first.id, "inbound", "changed", "message-one")).rejects.toMatchObject({ status: 409 });
    await expect(store.bindWorkspace("other:demo")).rejects.toThrow("different site or connector");
  });

  test("rolls back a failed batch and enforces the 2000-message limit", async () => {
    const { db, transport, store } = setup(); await store.ready();
    const conversation = await store.create("Visitor");
    await expect(transport.batch([
      { sql: "INSERT INTO settings (key,value) VALUES ('rollback-test','yes')" },
      { sql: "INSERT INTO missing_table VALUES (1)" },
    ])).rejects.toThrow();
    expect(db.query("SELECT value FROM settings WHERE key='rollback-test'").get()).toBeNull();
    const statements: D1Statement[] = [];
    const now = new Date().toISOString();
    for (let i = 0; i < 2000; i++) statements.push({
      sql: "INSERT INTO messages (conversation_id,direction,body,created_at,client_message_id,delivery_status) VALUES (?,'outbound','x',?,?,'sent')",
      params: [conversation.id, now, `seed-${i}`],
    });
    await transport.batch(statements);
    await expect(store.add(conversation.id, "inbound", "too many", "message-over-limit")).rejects.toEqual(
      new AppError(409, "This conversation has reached its message limit."));
  });

  test("deduplicates provider replies, enforces their limit, and recovers persisted sending state", async () => {
    const { db, transport, store } = setup(); await store.ready();
    const conversation = await store.create("Visitor");
    await store.thread(conversation.id, "sent", "thread-1");
    expect(await store.receiveReply("demo", "event-1", "thread-1", "answer")).toBe(true);
    expect(await store.receiveReply("demo", "event-1", "thread-1", "answer")).toBe(false);
    expect((await store.messages(conversation.id)).map(row => row.body)).toEqual(["answer"]);
    await store.add(conversation.id, "inbound", "pending", "pending-one");
    const pending = (await store.messages(conversation.id)).at(-1)!;
    await store.delivery(pending.id, "sending"); await store.thread(conversation.id, "sending");
    const restarted = new D1Store(transport); await restarted.ready();
    expect((await restarted.message(pending.id))!.deliveryStatus).toBe("unknown");
    expect((await restarted.conversation(conversation.id))!.threadState).toBe("unknown");
    db.query("DELETE FROM messages WHERE conversation_id=?").run(conversation.id);
    const insert = db.query("INSERT INTO messages (conversation_id,direction,body,created_at,client_message_id,delivery_status) VALUES (?,'outbound','x',?,?,'sent')");
    const now = new Date().toISOString(); db.transaction(() => { for (let i = 0; i < 2000; i++) insert.run(conversation.id, now, `limit-${i}`); })();
    await expect(restarted.receiveReply("demo", "event-2", "thread-1", "overflow")).rejects.toMatchObject({ status: 409 });
  });
});
