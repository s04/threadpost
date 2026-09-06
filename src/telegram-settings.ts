import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Config } from "./config";
import { TelegramConnector } from "./connectors";
import type { Bridge } from "./bridge";
import { AppError, secret } from "./store";

interface StoredTelegramConfig {
  botToken: string; botId: number; botUsername: string;
  chatId: string; operatorIds: string[]; webhookSecret: string;
}
export interface TelegramStatus {
  connected: boolean; botUsername?: string; chatId?: string; operatorIds?: string[]; error?: string;
}
export interface TelegramConnectInput { botToken: string; chatId: string; operatorIds: string[] }

export class TelegramSettings {
  private stored: StoredTelegramConfig | null = null;
  private loadError = false;
  private key: Buffer;
  constructor(
    private config: Config,
    private bridge: Bridge,
    encryptionKey: string,
    private transport: typeof fetch = fetch,
  ) {
    if (encryptionKey.length < 32) throw new Error("Telegram settings require a 32+ character encryption key.");
    this.key = createHash("sha256").update("threadpost:telegram-settings:v1\0").update(encryptionKey).digest();
  }

  async load() {
    const encrypted = await this.bridge.store.getSetting("telegram_config");
    if (!encrypted) return;
    try {
      const stored = this.decrypt(encrypted);
      this.validateStored(stored);
      this.apply(stored);
    } catch {
      this.loadError = true;
      throw new Error("Stored Telegram configuration could not be decrypted. Restore the original SETTINGS_KEY.");
    }
  }
  status(): TelegramStatus {
    if (this.loadError) return { connected: false, error: "Stored Telegram configuration could not be loaded." };
    if (!this.stored) return this.config.connector === "telegram"
      ? { connected: true, chatId: this.config.telegramChatId, operatorIds: [...this.config.telegramOperators] }
      : { connected: false };
    return { connected: true, botUsername: this.stored.botUsername, chatId: this.stored.chatId,
      operatorIds: [...this.stored.operatorIds] };
  }

  async connect(input: TelegramConnectInput): Promise<TelegramStatus> {
    if (this.loadError) throw new AppError(409, "Stored Telegram configuration must be repaired before reconnecting.");
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(input.botToken) || !/^-\d+$/.test(input.chatId)
      || !Array.isArray(input.operatorIds) || !input.operatorIds.length
      || input.operatorIds.some(id => !/^\d+$/.test(id)))
      throw new AppError(400, "Enter a valid bot token, group ID, and operator IDs.");
    const operatorIds = [...new Set(input.operatorIds)];
    if (this.stored && (this.stored.botToken !== input.botToken || this.stored.chatId !== input.chatId))
      throw new AppError(409, "This inbox cannot be rerouted to a different bot or group.");
    if (!this.stored && this.config.connector !== "demo")
      throw new AppError(409, "This inbox is already connected to another provider.");
    if (this.bridge.busy) throw new AppError(409, "Message delivery is in progress. Try again shortly.");
    const counts = await this.bridge.store.counts();
    if (counts.pending || counts.failed) throw new AppError(409, "Resolve pending or failed deliveries before connecting Telegram.");

    const me = await this.call(input.botToken, "getMe", {});
    if (!Number.isSafeInteger(me?.id) || me.id <= 0 || me?.is_bot !== true || typeof me?.username !== "string")
      throw new AppError(400, "Telegram did not return a valid bot account.");
    const chat = await this.call(input.botToken, "getChat", { chat_id: input.chatId });
    if (String(chat?.id) !== input.chatId || chat?.type !== "supergroup" || chat?.is_forum !== true)
      throw new AppError(400, "Choose a Telegram supergroup with Topics enabled.");
    if (chat.username || (Array.isArray(chat.active_usernames) && chat.active_usernames.length))
      throw new AppError(400, "Use a private Telegram group without a public username.");
    const membership = await this.call(input.botToken, "getChatMember", { chat_id: input.chatId, user_id: me.id });
    if (membership?.status !== "creator" && (membership?.status !== "administrator" || membership?.can_manage_topics !== true))
      throw new AppError(400, "The bot must be an administrator allowed to manage topics.");
    const webhookUrl = `${this.config.publicUrl}/webhooks/telegram`;
    const webhook = await this.call(input.botToken, "getWebhookInfo", {});
    if (typeof webhook?.url !== "string" || (webhook.url && webhook.url !== webhookUrl))
      throw new AppError(409, "This bot already has a webhook configured elsewhere.");

    const stored: StoredTelegramConfig = { botToken: input.botToken, botId: me.id,
      botUsername: me.username, chatId: input.chatId, operatorIds, webhookSecret: secret() };
    const webhookSet = await this.call(input.botToken, "setWebhook", { url: webhookUrl, secret_token: stored.webhookSecret,
      allowed_updates: ["message"] });
    if (webhookSet !== true) throw new AppError(502, "Telegram could not configure the webhook. Try again.");
    await this.bridge.store.saveTelegramSettings(this.encrypt(stored), !this.stored);
    this.apply(stored);
    return this.status();
  }

  private apply(stored: StoredTelegramConfig) {
    this.stored = stored; this.loadError = false;
    this.config.connector = "telegram"; this.config.telegramToken = stored.botToken;
    this.config.telegramChatId = stored.chatId; this.config.telegramOperators = [...stored.operatorIds];
    this.config.webhookSecret = stored.webhookSecret;
    this.bridge.connector = new TelegramConnector(this.config, this.transport);
  }
  private async call(token: string, method: string, payload: Record<string, unknown>) {
    try {
      const response = await this.transport(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(12_000),
      });
      const data = await response.json() as { ok?: boolean; result?: unknown };
      if (!response.ok || data.ok !== true) {
        const guidance: Record<string, string> = {
          getMe: "Telegram rejected the bot token. Copy the current token from BotFather and try again.",
          getChat: "Telegram could not access that group. Check the -100 chat ID and add your bot to the group.",
          getChatMember: "Telegram could not check the bot’s permissions. Make the bot a group administrator with Manage Topics permission.",
          getWebhookInfo: "Telegram could not check the bot’s webhook. Try again shortly.",
          setWebhook: "Telegram could not register the webhook. Check the server’s public HTTPS address and try again.",
        };
        throw new AppError(502, response.status === 429 ? "Telegram is rate limiting setup requests. Wait a minute before trying again."
          : response.status >= 500 ? "Telegram is temporarily unavailable. Try again shortly."
          : guidance[method] || "Telegram rejected this setup request.");
      }
      return data.result as any;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, "Could not reach Telegram while checking " + ({ getMe: "the bot token", getChat: "the group", getChatMember: "bot permissions", getWebhookInfo: "the existing webhook", setWebhook: "webhook registration" }[method] || "setup") + ". Try again shortly.");
    }
  }
  private encrypt(value: StoredTelegramConfig) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }
  private decrypt(value: string): StoredTelegramConfig {
    const [version, iv, tag, ciphertext, extra] = value.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext || extra) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8"));
  }
  private validateStored(value: any): asserts value is StoredTelegramConfig {
    if (!value || !/^\d+:[A-Za-z0-9_-]+$/.test(value.botToken) || !Number.isSafeInteger(value.botId) || value.botId <= 0
      || typeof value.botUsername !== "string" || !/^-\d+$/.test(value.chatId)
      || !Array.isArray(value.operatorIds) || !value.operatorIds.length || value.operatorIds.some((id: unknown) => typeof id !== "string" || !/^\d+$/.test(id))
      || typeof value.webhookSecret !== "string" || value.webhookSecret.length < 32) throw new Error();
  }
}
