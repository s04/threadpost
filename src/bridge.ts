import { Store, AppError } from "./store";
import { DeliveryError, type Connector, type OperatorReply } from "./connectors";
import type { Config } from "./config";

export class Bridge {
  busy = false;
  constructor(public store: Store, public connector: Connector) {}
  async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const message of this.store.pending()) {
        const conversation = this.store.conversation(message.conversationId);
        if (!conversation) continue;
        if (["failed", "unknown"].includes(conversation.threadState)) {
          this.store.delivery(message.id, conversation.threadState); continue;
        }
        this.store.delivery(message.id, "sending");
        try {
          let threadId = conversation.threadId;
          if (!threadId) {
            this.store.thread(conversation.id, "sending");
            try {
              threadId = await this.connector.createThread(conversation.id);
              this.store.thread(conversation.id, "sent", threadId);
            } catch (error) {
              this.store.thread(conversation.id, error instanceof DeliveryError && !error.uncertain ? "failed" : "unknown");
              throw error;
            }
          }
          // Deletion during a provider request must not send a later message.
          if (!this.store.conversation(conversation.id)) continue;
          await this.connector.send(threadId, message.body);
          this.store.delivery(message.id, "sent");
        } catch (error) {
          this.store.delivery(message.id, error instanceof DeliveryError && !error.uncertain ? "failed" : "unknown");
        }
      }
    } finally { this.busy = false; }
  }
  retry(id: number) {
    const message = this.store.message(id);
    if (!message) throw new AppError(404, "Message not found.");
    if (!["failed", "unknown"].includes(message.deliveryStatus)) throw new AppError(409, "Only failed or uncertain deliveries can be retried.");
    const conversation = this.store.require(message.conversationId);
    if (!conversation.threadId) this.store.thread(conversation.id, "pending");
    this.store.delivery(id, "pending");
    return this.store.message(id);
  }
  telegram(update: any, config: Config) {
    const message = update?.message;
    if (!Number.isSafeInteger(update?.update_id)) throw new AppError(400, "Invalid update.");
    if (!message || String(message.chat?.id) !== config.telegramChatId
        || !config.telegramOperators.includes(String(message.from?.id)) || message.from?.is_bot
        || !Number.isSafeInteger(message.message_thread_id) || typeof message.text !== "string"
        || message.text.startsWith("/")) return;
    const body = message.text.trim();
    if (!body || body.startsWith("/") || body.length > 2000) return;
    this.receive({ eventId: String(update.update_id), threadId: String(message.message_thread_id), body });
  }
  /** Call only after checking the provider signature, workspace and operator identity. */
  receive(reply: OperatorReply) {
    if (!reply.eventId || reply.eventId.length > 200 || !reply.threadId || reply.threadId.length > 200
      || !reply.body.trim() || reply.body.length > 2000) throw new AppError(400, "Invalid operator reply.");
    return this.store.db.transaction(() => {
      if (this.store.db.query("SELECT event_id FROM connector_events WHERE connector=? AND event_id=?").get(this.connector.kind, reply.eventId)) return false;
      const row = this.store.db.query("SELECT id FROM conversations WHERE thread_id=?").get(reply.threadId) as { id: string } | null;
      if (!row) return false;
      this.store.setStatus(row.id, "open");
      this.store.add(row.id, "outbound", reply.body.trim(), `provider-${this.connector.kind}-${reply.eventId}`);
      this.store.db.query("INSERT INTO connector_events (connector,event_id,created_at) VALUES (?,?,?)")
        .run(this.connector.kind, reply.eventId, new Date().toISOString());
      return true;
    })();
  }
}
