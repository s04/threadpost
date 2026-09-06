import type { Config } from "./config";

/** A connector owns provider transport; it does not own visitor authentication. */
export interface ConversationContext { sourcePath?: string | null }
export interface Connector {
  kind: string;
  createThread(conversationId: string, context?: ConversationContext): Promise<string>;
  send(threadId: string, body: string): Promise<void>;
}

/** Normalized, already-authenticated provider input. The bridge deduplicates eventId. */
export interface OperatorReply {
  eventId: string;
  threadId: string;
  body: string;
}

/** Unknown means the provider may have accepted the request before transport failed. */
export class DeliveryError extends Error {
  constructor(public uncertain: boolean) { super(uncertain ? "Delivery outcome unknown" : "Provider rejected delivery"); }
}

export class DemoConnector implements Connector {
  kind = "demo";
  async createThread(id: string) { return `demo-${id}`; }
  async send(_thread: string, _body: string) { /* Local simulation; no external traffic. */ }
}

export class TelegramConnector implements Connector {
  kind = "telegram";
  constructor(private config: Config, private transport: typeof fetch = fetch) {}
  async call(method: string, payload: Record<string, unknown>): Promise<any> {
    try {
      const response = await this.transport(`https://api.telegram.org/bot${this.config.telegramToken}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(12_000),
      });
      const data = await response.json() as { ok?: boolean; result?: unknown };
      if (!response.ok || data.ok !== true) throw new DeliveryError(response.status >= 500);
      return data.result;
    } catch (error) {
      // Never surface transport errors: their URL can contain the bot token.
      if (error instanceof DeliveryError) throw error;
      throw new DeliveryError(true);
    }
  }
  async createThread(id: string, context?: ConversationContext): Promise<string> {
    const clean = (value: string) => value
      .replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ").trim();
    const clip = (value: string, length: number) => Array.from(value).slice(0, length).join("");
    const site = clip(clean(this.config.siteName) || this.config.siteId, 40);
    const reportedPath = context?.sourcePath ? clip(clean(context.sourcePath), 48) : "";
    const fullName = `${site} · Visitor ${id.slice(0, 8)}${reportedPath ? ` · Reported page ${reportedPath}` : ""}`;
    const name = Array.from(fullName).slice(0, 128).join("");
    const result = await this.call("createForumTopic", {
      chat_id: this.config.telegramChatId, name,
    });
    if (!Number.isSafeInteger(result?.message_thread_id)) throw new DeliveryError(true);
    return String(result.message_thread_id);
  }
  async send(threadId: string, body: string) {
    await this.call("sendMessage", {
      chat_id: this.config.telegramChatId, message_thread_id: Number(threadId),
      text: `Visitor message\n\n${body}`, link_preview_options: { is_disabled: true },
    });
  }
}
