import { AppError, type Storage } from "./store";
import { DeliveryError, type Connector, type OperatorReply } from "./connectors";
import type { Config } from "./config";

export class Bridge {
  busy = false;
  constructor(public store: Storage, public connector: Connector) {}
  async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const message of await this.store.pending()) {
        const conversation = await this.store.conversation(message.conversationId);
        if (!conversation) continue;
        if (["failed", "unknown"].includes(conversation.threadState)) {
          await this.store.delivery(message.id, conversation.threadState); continue;
        }
        await this.store.delivery(message.id, "sending");
        try {
          let threadId = conversation.threadId;
          if (!threadId) {
            await this.store.thread(conversation.id, "sending");
            try {
              threadId = await this.connector.createThread(conversation.id, { sourcePath: conversation.sourcePath });
              await this.store.thread(conversation.id, "sent", threadId);
            } catch (error) {
              await this.store.thread(conversation.id, error instanceof DeliveryError && !error.uncertain ? "failed" : "unknown");
              throw error;
            }
          }
          // Deletion during a provider request must not send a later message.
          if (!await this.store.conversation(conversation.id)) continue;
          await this.connector.send(threadId, message.body);
          await this.store.delivery(message.id, "sent");
        } catch (error) {
          await this.store.delivery(message.id, error instanceof DeliveryError && !error.uncertain ? "failed" : "unknown");
        }
      }
    } finally { this.busy = false; }
  }
  async retry(id: number) {
    const message = await this.store.message(id);
    if (!message) throw new AppError(404, "Message not found.");
    if (!["failed", "unknown"].includes(message.deliveryStatus)) throw new AppError(409, "Only failed or uncertain deliveries can be retried.");
    const conversation = await this.store.require(message.conversationId);
    if (conversation.blocked) throw new AppError(403, "Unblock this conversation before retrying delivery.");
    if (!conversation.threadId) await this.store.thread(conversation.id, "pending");
    await this.store.delivery(id, "pending");
    return this.store.message(id);
  }
  async telegram(update: any, config: Config) {
    const message = update?.message;
    if (!Number.isSafeInteger(update?.update_id)) throw new AppError(400, "Invalid update.");
    if (!message || String(message.chat?.id) !== config.telegramChatId
        || !config.telegramOperators.includes(String(message.from?.id)) || message.from?.is_bot
        || !Number.isSafeInteger(message.message_thread_id) || typeof message.text !== "string"
        || message.text.startsWith("/")) return;
    const body = message.text.trim();
    if (!body || body.startsWith("/") || body.length > 2000) return;
    await this.receive({ eventId: String(update.update_id), threadId: String(message.message_thread_id), body });
  }
  /** Call only after checking the provider signature, workspace and operator identity. */
  async receive(reply: OperatorReply) {
    if (!reply.eventId || reply.eventId.length > 200 || !reply.threadId || reply.threadId.length > 200
      || !reply.body.trim() || reply.body.length > 2000) throw new AppError(400, "Invalid operator reply.");
    return this.store.receiveReply(this.connector.kind, reply.eventId, reply.threadId, reply.body.trim());
  }
}
