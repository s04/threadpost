import { readConfig } from "./config";
import { TelegramConnector } from "./connectors";

const config = readConfig();
if (config.connector !== "telegram" || !config.publicUrl.startsWith("https:")) {
  console.error("Configure CONNECTOR=telegram and an HTTPS PUBLIC_URL first."); process.exit(1);
}
const api = new TelegramConnector(config);
try {
  const bot = await api.call("getMe", {});
  const group = await api.call("getChat", { chat_id: config.telegramChatId });
  const member = await api.call("getChatMember", { chat_id: config.telegramChatId, user_id: bot.id });
  if (group.type !== "supergroup" || !group.is_forum || member.status !== "administrator" || !member.can_manage_topics)
    throw new Error("The bot must be an administrator with Manage Topics in a private forum supergroup.");
  if (group.username) throw new Error("Use a private operator group without a public username.");
  await api.call("setWebhook", { url: `${config.publicUrl}/webhooks/telegram`, secret_token: config.webhookSecret,
    allowed_updates: ["message"], drop_pending_updates: false });
  console.log("Telegram webhook registered. Only configured operator IDs can reply to visitors.");
} catch {
  console.error("Setup failed. Check the bot credentials, private forum group, bot topic permissions and HTTPS endpoint.");
  process.exit(1);
}
