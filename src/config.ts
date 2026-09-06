export interface Config {
  host: string; port: number; publicUrl: string; adminToken: string; dbPath: string;
  siteId: string; siteName: string; origins: string[]; connector: "demo" | "telegram";
  telegramToken: string; telegramChatId: string; telegramOperators: string[]; webhookSecret: string;
  turnstileSiteKey?: string; turnstileSecret?: string;
  maxNewConversationsPerDay?: number; maxMessagesPerDay?: number;
}

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const publicUrl = new URL(env.PUBLIC_URL || "http://localhost:8788");
  const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  const local = loopback(publicUrl.hostname);
  if ((!local && publicUrl.protocol !== "https:") || !["http:", "https:"].includes(publicUrl.protocol)
      || publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash)
    throw new Error("PUBLIC_URL must be an HTTPS origin (HTTP is allowed for localhost).");
  const adminToken = env.ADMIN_TOKEN || "";
  if (adminToken.length < 32 || /replace|example|change.me/i.test(adminToken))
    throw new Error("Set ADMIN_TOKEN to a newly generated secret of at least 32 characters.");
  const connector = env.CONNECTOR || "demo";
  if (connector !== "demo" && connector !== "telegram") throw new Error("CONNECTOR must be demo or telegram.");
  const origins = [...new Set([publicUrl.origin, ...(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean).map(s => {
    const url = new URL(s);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.origin !== s)
      throw new Error("ALLOWED_ORIGINS must contain exact HTTP(S) origins, without paths or wildcards.");
    if (url.protocol !== "https:" && !loopback(url.hostname))
      throw new Error("ALLOWED_ORIGINS must use HTTPS (HTTP is allowed for localhost).");
    return url.origin;
  })])];
  const config: Config = {
    host: env.HOST || "127.0.0.1", port: Number(env.PORT || "8788"), publicUrl: publicUrl.origin,
    adminToken, dbPath: env.DB_PATH || "data/threadpost.sqlite", siteId: env.SITE_ID || "demo",
    siteName: env.SITE_NAME || "Demo site", origins, connector,
    telegramToken: env.TELEGRAM_BOT_TOKEN || "", telegramChatId: env.TELEGRAM_CHAT_ID || "",
    telegramOperators: (env.TELEGRAM_OPERATOR_IDS || "").split(",").map(s => s.trim()).filter(Boolean),
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || "",
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || "", turnstileSecret: env.TURNSTILE_SECRET_KEY || "",
    maxNewConversationsPerDay: Number(env.MAX_NEW_CONVERSATIONS_PER_DAY || "200"),
    maxMessagesPerDay: Number(env.MAX_MESSAGES_PER_DAY || "5000"),
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("Invalid PORT.");
  if (Boolean(config.turnstileSiteKey) !== Boolean(config.turnstileSecret)) throw new Error("Configure both Turnstile keys together.");
  if (![config.maxNewConversationsPerDay, config.maxMessagesPerDay].every(n => Number.isSafeInteger(n) && n! > 0))
    throw new Error("Daily chat limits must be positive integers.");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(config.siteId)) throw new Error("SITE_ID must be 1-64 letters, digits, underscores or hyphens.");
  if (connector === "telegram" && (!/^\d+:[A-Za-z0-9_-]+$/.test(config.telegramToken)
    || !/^-\d+$/.test(config.telegramChatId) || !config.telegramOperators.length
    || config.telegramOperators.some(id => !/^\d+$/.test(id))
    || !/^[A-Za-z0-9_-]{32,256}$/.test(config.webhookSecret)))
    throw new Error("Telegram requires a bot token, group ID, operator user IDs and a 32+ character webhook secret.");
  return config;
}
