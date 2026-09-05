import type { Config } from "./config";

/** A connector owns provider transport; it does not own visitor authentication. */
export interface Connector {
  kind: string;
  createThread(conversationId: string): Promise<string>;
  send(threadId: string, body: string): Promise<void>;
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
  async createThread(id: string): Promise<string> {
    const result = await this.call("createForumTopic", {
      chat_id: this.config.telegramChatId, name: `Visitor ${id.slice(0, 8)}`,
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
