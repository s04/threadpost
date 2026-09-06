import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { D1Store, type D1Result, type D1Statement, type D1Transport } from "../src/d1-store";
import { AppError } from "../src/store";
import { schemaStatements } from "../src/schema";

class SQLiteD1Transport implements D1Transport {
  constructor(readonly db: Database) { db.exec(`PRAGMA foreign_keys=ON; ${schemaStatements.join(";")}`); }
  async batch(statements: D1Statement[]): Promise<D1Result[]> {
    return this.db.transaction(() => statements.map(({ sql, params = [] }) => {
      const statement = this.db.query(sql);
      if (/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(sql)) {
        return { results: statement.all(...params) as Record<string, unknown>[], meta: {} };
      }
      const result = statement.run(...params);
      return { results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
    }))();
  }
}

const databases: Database[] = [];
function setup() {
  const db = new Database(":memory:", { strict: true }); databases.push(db);
  const transport = new SQLiteD1Transport(db);
  return { db, transport, store: new D1Store(transport) };
}
afterEach(() => { while (databases.length) databases.pop()!.close(); });

describe("D1Store", () => {
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
