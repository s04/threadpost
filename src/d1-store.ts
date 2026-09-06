import { AppError, hash, secret, type Conversation, type Message, type Storage } from "./store";
import { recoveryStatements } from "./schema";

export type D1Value = string | number | null;
export interface D1Statement { sql: string; params?: D1Value[] }
export interface D1Result {
  results: Record<string, unknown>[];
  meta?: { last_row_id?: number; changes?: number };
}
export interface D1Transport { batch(statements: D1Statement[]): Promise<D1Result[]> }

const conversationColumns = `id,name,status,created_at AS createdAt,updated_at AS updatedAt,
 token_hash AS tokenHash,thread_id AS threadId,thread_state AS threadState,expires_at AS expiresAt,
 source_origin AS sourceOrigin,source_path AS sourcePath,blocked`;
const messageColumns = `id,conversation_id AS conversationId,direction,body,created_at AS createdAt,
 delivery_status AS deliveryStatus,client_message_id AS clientMessageId`;
const conversationRow = (row: (Conversation & Record<string, unknown>) | undefined) => row ? { ...row, blocked: Boolean(row.blocked) } : null;

/** Multi-step read/write operations require callers to route one workspace through a single serialized writer. */
export class D1Store implements Storage {
  constructor(private transport: D1Transport) {}

  private async query<T extends Record<string, unknown>>(sql: string, params: D1Value[] = []): Promise<T[]> {
    const [result] = await this.transport.batch([{ sql, params }]);
    return result.results as T[];
  }
  async initialize() { await this.transport.batch(recoveryStatements.map(sql => ({ sql }))); }
  async ready() { await this.initialize(); }
  async close() {}

  async bindWorkspace(binding: string) {
    const [existing] = await this.query<{ value: string }>("SELECT value FROM settings WHERE key='workspace'");
    if (existing && existing.value !== binding)
      throw new Error("This database belongs to a different site or connector. Use a new database; preserve the old database separately.");
    if (!existing) {
      await this.transport.batch([{ sql: "INSERT OR IGNORE INTO settings (key,value) VALUES ('workspace',?)", params: [binding] }]);
      const [bound] = await this.query<{ value: string }>("SELECT value FROM settings WHERE key='workspace'");
      if (!bound || bound.value !== binding)
        throw new Error("This database belongs to a different site or connector. Use a new database; preserve the old database separately.");
    }
  }
  async conversation(id: string) {
    return conversationRow((await this.query<Conversation & Record<string, unknown>>(`SELECT ${conversationColumns} FROM conversations WHERE id=?`, [id]))[0]);
  }
  async require(id: string) {
    const row = await this.conversation(id);
    if (!row) throw new AppError(404, "Conversation not found.");
    return row;
  }
  async create(name: string, token = secret(), source: { origin: string | null; path: string | null } = { origin: null, path: null }) {
    const now = new Date().toISOString();
    const [existing] = await this.query<{ id: string; status: string; expiresAt: string }>(
      "SELECT id,status,expires_at AS expiresAt FROM conversations WHERE token_hash=?", [hash(token)]);
    if (existing) {
      if (existing.expiresAt < now) throw new AppError(401, "This conversation link has expired.");
      return { id: existing.id, token, status: existing.status };
    }
    const id = crypto.randomUUID(), expires = new Date(Date.now() + 30 * 86400_000).toISOString();
    await this.transport.batch([{ sql: "INSERT INTO conversations (id,name,token_hash,created_at,updated_at,expires_at,source_origin,source_path) VALUES (?,?,?,?,?,?,?,?)",
      params: [id, name || "Visitor", hash(token), now, now, expires, source.origin, source.path] }]);
    return { id, token, status: "open" };
  }
  async findByToken(token: string) {
    return conversationRow((await this.query<Conversation & Record<string, unknown>>(`SELECT ${conversationColumns} FROM conversations WHERE token_hash=?`, [hash(token)]))[0]);
  }
  async authenticate(id: string, token: string) {
    const row = await this.conversation(id);
    if (!row || hash(token) !== row.tokenHash || row.expiresAt < new Date().toISOString())
      throw new AppError(401, "This conversation link is invalid or expired.");
    return row;
  }
  async messages(id: string) {
    return this.query<Message & Record<string, unknown>>(`SELECT ${messageColumns} FROM messages WHERE conversation_id=? ORDER BY id`, [id]);
  }
  async message(id: number) {
    return (await this.query<Message & Record<string, unknown>>(`SELECT ${messageColumns} FROM messages WHERE id=?`, [id]))[0] || null;
  }
  async findMessage(conversationId: string, direction: "inbound" | "outbound", clientId: string) {
    return (await this.query<Message & Record<string, unknown>>(
      `SELECT ${messageColumns} FROM messages WHERE conversation_id=? AND direction=? AND client_message_id=?`,
      [conversationId, direction, clientId]))[0] || null;
  }
  async add(id: string, direction: "inbound" | "outbound", body: string, clientId: string) {
    const conversation = await this.require(id);
    if (direction === "inbound" && conversation.blocked) throw new AppError(403, "This conversation is blocked.");
    const old = await this.findMessage(id, direction, clientId);
    if (old) {
      if (old.body !== body) throw new AppError(409, "This message ID was already used for different text.");
      return old;
    }
    if (conversation.status === "closed") throw new AppError(409, "This conversation is closed.");
    const [count] = await this.query<{ n: number }>("SELECT count(*) AS n FROM messages WHERE conversation_id=?", [id]);
    if (Number(count.n) >= 2000) throw new AppError(409, "This conversation has reached its message limit.");
    const now = new Date().toISOString();
    const results = await this.transport.batch([
      { sql: "INSERT INTO messages (conversation_id,direction,body,created_at,client_message_id,delivery_status) VALUES (?,?,?,?,?,?) RETURNING id",
        params: [id, direction, body, now, clientId, direction === "inbound" ? "pending" : "sent"] },
      { sql: "UPDATE conversations SET updated_at=? WHERE id=?", params: [now, id] },
    ]);
    const inserted = results[0].results[0] as { id?: number } | undefined;
    const messageId = Number(inserted?.id ?? results[0].meta?.last_row_id);
    const row = await this.message(messageId);
    if (!row) throw new Error("Inserted message was not returned by D1.");
    return row;
  }
  async list() {
    return (await this.query(`SELECT id,name,status,created_at AS createdAt,updated_at AS updatedAt,
      (SELECT body FROM messages WHERE conversation_id=conversations.id ORDER BY id DESC LIMIT 1) AS lastMessage,
      (SELECT count(*) FROM messages WHERE conversation_id=conversations.id) AS messageCount,
      source_origin AS sourceOrigin,source_path AS sourcePath,blocked,
      (SELECT max(id) FROM messages WHERE conversation_id=conversations.id AND direction='inbound') AS lastInboundId
      FROM conversations ORDER BY updated_at DESC LIMIT 200`)).map(row => ({ ...row, blocked: Boolean(row.blocked) }));
  }
  async counts() {
    const [row] = await this.query<{ open: number; closed: number; pending: number; failed: number }>(`SELECT
      (SELECT count(*) FROM conversations WHERE status='open') AS open,
      (SELECT count(*) FROM conversations WHERE status='closed') AS closed,
      (SELECT count(*) FROM messages WHERE delivery_status IN ('pending','sending')) AS pending,
      (SELECT count(*) FROM messages WHERE delivery_status IN ('failed','unknown')) AS failed`);
    return { open: Number(row.open), closed: Number(row.closed), pending: Number(row.pending), failed: Number(row.failed) };
  }
  async setStatus(id: string, status: string) {
    await this.require(id);
    await this.transport.batch([{ sql: "UPDATE conversations SET status=?,updated_at=? WHERE id=?", params: [status, new Date().toISOString(), id] }]);
    return this.require(id);
  }
  async setBlocked(id: string, blocked: boolean) {
    await this.require(id);
    await this.transport.batch([{ sql: "UPDATE conversations SET blocked=?,updated_at=? WHERE id=?", params: [blocked ? 1 : 0, new Date().toISOString(), id] }]);
    return this.require(id);
  }
  async pending() {
    return this.query<Message & Record<string, unknown>>(`SELECT ${messageColumns} FROM messages WHERE delivery_status='pending'
      AND EXISTS (SELECT 1 FROM conversations WHERE conversations.id=messages.conversation_id AND conversations.blocked=0)
      AND NOT EXISTS (SELECT 1 FROM messages AS earlier WHERE earlier.conversation_id=messages.conversation_id
        AND earlier.direction='inbound' AND earlier.id < messages.id AND earlier.delivery_status != 'sent')
      ORDER BY id LIMIT 25`);
  }
  async delivery(id: number, status: string) {
    await this.transport.batch([{ sql: "UPDATE messages SET delivery_status=? WHERE id=?", params: [status, id] }]);
  }
  async thread(id: string, state: string, threadId: string | null = null) {
    await this.transport.batch([{ sql: "UPDATE conversations SET thread_state=?,thread_id=coalesce(?,thread_id) WHERE id=?", params: [state, threadId, id] }]);
  }
  async delete(id: string) {
    await this.require(id);
    await this.transport.batch([{ sql: "DELETE FROM conversations WHERE id=?", params: [id] }]);
  }
  async receiveReply(connector: string, eventId: string, threadId: string, body: string) {
    const [seen] = await this.query<{ eventId: string }>(
      "SELECT event_id AS eventId FROM connector_events WHERE connector=? AND event_id=?", [connector, eventId]);
    if (seen) return false;
    const [conversation] = await this.query<{ id: string; blocked: number }>("SELECT id,blocked FROM conversations WHERE thread_id=?", [threadId]);
    if (!conversation) return false;
    if (conversation.blocked) return false;
    const [count] = await this.query<{ n: number }>("SELECT count(*) AS n FROM messages WHERE conversation_id=?", [conversation.id]);
    if (Number(count.n) >= 2000) throw new AppError(409, "This conversation has reached its message limit.");
    const now = new Date().toISOString(), clientId = `provider-${connector}-${eventId}`;
    await this.transport.batch([
      { sql: "UPDATE conversations SET status='open',updated_at=? WHERE id=?", params: [now, conversation.id] },
      { sql: "INSERT INTO messages (conversation_id,direction,body,created_at,client_message_id,delivery_status) VALUES (?,'outbound',?,?,?,'sent')",
        params: [conversation.id, body, now, clientId] },
      { sql: "INSERT INTO connector_events (connector,event_id,created_at) VALUES (?,?,?)", params: [connector, eventId, now] },
    ]);
    return true;
  }
  async getSetting(key: string) {
    const [row] = await this.query<{ value: string }>("SELECT value FROM settings WHERE key=?", [key]);
    return row?.value || null;
  }
  async setSetting(key: string, value: string) {
    await this.transport.batch([{ sql: "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params: [key, value] }]);
  }
  async resetThreads() {
    await this.transport.batch([{ sql: "UPDATE conversations SET thread_id=NULL,thread_state='pending'" }]);
  }
  async saveTelegramSettings(value: string, resetThreads: boolean) {
    const statements: D1Statement[] = [
      { sql: "INSERT INTO settings (key,value) VALUES ('telegram_config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params: [value] },
    ];
    if (resetThreads) statements.push({ sql: "UPDATE conversations SET thread_id=NULL,thread_state='pending'" });
    await this.transport.batch(statements);
  }
  async consumeQuota(key: string, limit: number, periodMs: number, now = Date.now()) {
    if (!key || key.length > 200 || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(periodMs) || periodMs < 1)
      throw new Error("Invalid quota parameters.");
    const results = await this.transport.batch([
      { sql: "DELETE FROM rate_limits WHERE expires_at<=?", params: [now] },
      { sql: `INSERT INTO rate_limits (key,window_start,expires_at,count)
        SELECT ?,?,?,1 WHERE EXISTS (SELECT 1 FROM rate_limits WHERE key=?) OR (SELECT count(*) FROM rate_limits)<10000
        ON CONFLICT(key) DO UPDATE SET count=rate_limits.count+1 RETURNING count`, params: [key, now, now + periodMs, key] },
    ]);
    const row = results[1].results[0] as { count?: number } | undefined;
    return Boolean(row && Number(row.count) <= limit);
  }
}
