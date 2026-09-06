import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash, Store } from "../src/store";

const directories: string[] = [], stores: Store[] = [];
const databasePath = () => { const dir = mkdtempSync(join(tmpdir(), "threadpost-messaging-")); directories.push(dir); return join(dir, "store.sqlite"); };
afterEach(() => {
  for (const store of stores.splice(0)) try { store.close(); } catch {}
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("messaging storage", () => {
  test("records source attribution, exposes the last inbound watermark, and blocks visitor/provider messages", () => {
    const store = new Store(":memory:"); stores.push(store);
    const created = store.create("Visitor", undefined, { origin: "https://site.example", path: "/pricing" });
    expect(store.findByToken(created.token)).toMatchObject({ id: created.id, sourceOrigin: "https://site.example", sourcePath: "/pricing", blocked: false });
    const inbound = store.add(created.id, "inbound", "question", "question-one");
    expect(store.findMessage(created.id, "inbound", "question-one")?.id).toBe(inbound.id);
    expect(store.findMessage(created.id, "outbound", "question-one")).toBeNull();
    store.delivery(inbound.id, "sent"); store.thread(created.id, "sent", "thread-one");
    expect(store.list()[0]).toMatchObject({ sourceOrigin: "https://site.example", sourcePath: "/pricing", blocked: false, lastInboundId: inbound.id });
    expect(store.setBlocked(created.id, true).blocked).toBe(true);
    expect(() => store.add(created.id, "inbound", "question", "question-one")).toThrow("conversation is blocked");
    expect(() => store.add(created.id, "inbound", "blocked", "question-two")).toThrow("conversation is blocked");
    expect(store.receiveReply("telegram", "event-one", "thread-one", "operator reply")).toBe(false);
    expect(store.messages(created.id).map(message => message.body)).toEqual(["question"]);
  });

  test("excludes blocked conversations from the pending outbox without starving others", () => {
    const store = new Store(":memory:"); stores.push(store);
    const blocked = store.create("Blocked"), visible = store.create("Visible");
    const blockedMessage = store.add(blocked.id, "inbound", "blocked pending", "blocked-pending");
    const visibleMessage = store.add(visible.id, "inbound", "visible pending", "visible-pending");
    store.setBlocked(blocked.id, true);
    expect(store.pending().map(message => message.id)).toEqual([visibleMessage.id]);
    expect(store.message(blockedMessage.id)?.deliveryStatus).toBe("pending");
  });

  test("keeps fixed-window quotas across restart and resets expired buckets", () => {
    const path = databasePath(), key = `message:${hash("synthetic-ip")}`;
    let store = new Store(path); stores.push(store);
    expect(store.consumeQuota(key, 2, 1000, 10_000)).toBe(true);
    expect(store.consumeQuota(key, 2, 1000, 10_100)).toBe(true);
    expect(store.consumeQuota(key, 2, 1000, 10_200)).toBe(false);
    store.close(); stores.splice(stores.indexOf(store), 1);
    store = new Store(path); stores.push(store);
    expect(store.consumeQuota(key, 2, 1000, 10_300)).toBe(false);
    expect(store.consumeQuota(key, 2, 1000, 11_001)).toBe(true);
  });

  test("migrates an existing SQLite database without losing conversations", () => {
    const path = databasePath(), db = new Database(path);
    db.exec(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT NOT NULL,thread_id TEXT UNIQUE,
      thread_state TEXT NOT NULL DEFAULT 'pending'
    )`);
    db.query("INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?)").run(
      "old-conversation", "Existing", "open", hash("old-token"), "2025-01-01", "2025-01-01", "2099-01-01", null, "pending");
    db.close();
    const store = new Store(path); stores.push(store);
    expect(store.conversation("old-conversation")).toMatchObject({ name: "Existing", sourceOrigin: null, sourcePath: null, blocked: false });
    expect(store.consumeQuota(hash("migration-key"), 1, 1000, 100)).toBe(true);
  });
});
