# Connect Threadpost to Telegram

Threadpost uses one private Telegram forum group as an operator inbox. Each new website conversation creates one forum topic. Operators listed in Threadpost can reply with plain-text messages inside that topic.

Complete these steps in order. In particular, collect operator IDs before connecting Threadpost because Telegram does not allow `getUpdates` while a webhook is active.

## 1. Create a dedicated bot

1. In Telegram, open the verified **@BotFather** account.
2. Send `/newbot`.
3. Choose a display name, then a unique username ending in `bot`.
4. Copy the token BotFather returns. Treat it like a password: anyone with this token can control the bot. Do not paste it into an issue, chat, screenshot, or source file.

If a token is exposed, use BotFather to revoke it and generate a replacement before continuing. Telegram documents bot creation and token handling in its [BotFather guide](https://core.telegram.org/bots/features#botfather).

## 2. Create the private forum group

Create a new Telegram group for Threadpost operators. Add only people who should be able to see visitor conversations.

Open the group settings and:

1. Keep the group **private**. Threadpost rejects a group with a public username.
2. Enable **Topics**. Telegram may describe the group as a forum after this is enabled.
3. Add each operator who should use this inbox.

Threadpost needs a supergroup with Topics enabled. An ordinary group or channel will be rejected.

## 3. Add the bot as an administrator

Adding the bot as a member is not enough. It must be an administrator with the specific **Manage Topics** permission.

1. Open **Group info**.
2. Choose **Edit** or **Manage Group**, then **Administrators**.
3. Choose **Add Administrator** and search for the exact bot username BotFather created.
4. Select the bot, enable **Manage Topics**, and save.
5. Reopen the bot’s administrator entry and confirm **Manage Topics** is still enabled.

Telegram’s menu names vary by app. Its official FAQ lists the administrator paths as:

- iPhone/iPad: **Group Info → Edit → Administrators**
- Android: **Group Info → pencil icon → Administrators**
- Desktop: **⋯ → Manage group → Administrators**

Telegram requires the `manage_topics` administrator right to create and manage forum topics. See the official [forum topic documentation](https://core.telegram.org/api/forum) and [group administrator guidance](https://telegram.org/faq#q-can-i-assign-administrators).

## 4. Find the private forum chat ID

Threadpost expects the Bot API form of the group ID, a negative number beginning with `-100`.

First, send an ordinary text message inside any topic in the private group. Copy the link from the **message bubble**, rather than the topic name, group title, or invite screen:

- **Android or iPhone/iPad:** long-press the message bubble and choose **Copy Message Link** or **Copy Link**. If long-press selects the message, look in the selection toolbar’s **⋮ / More** menu. Some Android versions open the message menu with a single tap.
- **Telegram Desktop:** right-click the message bubble. Control-click also works on macOS. Choose **Copy Message Link** or **Copy Link**.
- **Telegram Web:** open the group and topic at [web.telegram.org](https://web.telegram.org/), right-click the message bubble, and choose **Copy Message Link** or **Copy Link**. On a touch device, long-press it.

A private message link resembles:

```text
https://t.me/c/1234567890/12/34
```

Take only the first number after `/c/`, then add `-100` in front:

```text
1234567890 → -1001234567890
```

Ignore later topic and message numbers. A `t.me/+…` link is an invite link and cannot be converted this way. If **Copy Message Link** is missing, confirm Topics is enabled, try a normal text message inside a topic, or use Telegram Desktop/Web. Telegram documents the [private message-link format](https://core.telegram.org/api/links#message-links) and [Bot API supergroup ID format](https://core.telegram.org/api/bots/ids#supergroup-channel-ids).

## 5. Find each operator’s numeric user ID

Threadpost accepts numeric user IDs, not names or `@usernames`. Only listed IDs can relay a Telegram topic message to a website visitor.

The most private method uses your new bot and Telegram’s Bot API directly:

1. Before connecting Threadpost, ask each operator to open the exact bot username created in step 1.
2. Each operator taps **Start** or sends `/start` to the bot in a private chat.
3. From the Threadpost checkout, run the command below. It prompts for the token without displaying it or putting it in shell history, downloads the bot’s pending updates, and prints only sender IDs and account labels.

```sh
read -rsp "Bot token: " THREADPOST_BOT_TOKEN; echo
export THREADPOST_BOT_TOKEN
bun -e '
const response = await fetch(`https://api.telegram.org/bot${process.env.THREADPOST_BOT_TOKEN}/getUpdates`);
const payload = await response.json();
if (!payload.ok) throw new Error(payload.description || "Telegram rejected the request");
const operators = new Map();
for (const update of payload.result) {
  const from = update.message?.from ?? update.edited_message?.from;
  if (from && !from.is_bot) operators.set(String(from.id), {
    id: String(from.id),
    username: from.username ? `@${from.username}` : "",
    name: [from.first_name, from.last_name].filter(Boolean).join(" ")
  });
}
console.table([...operators.values()]);
'
unset THREADPOST_BOT_TOKEN
```

If an operator is missing, have that person send the bot a new private message and run the command again. Match the returned ID to the expected account before allowing it.

Run this before connecting Threadpost. Telegram makes long polling with `getUpdates` and webhook delivery mutually exclusive. After Threadpost registers its webhook, this command will report a conflict unless that webhook is removed. See the official [`getUpdates` documentation](https://core.telegram.org/bots/api#getupdates).

Third-party “user info” bots can also report an ID, but they receive account metadata and may be impersonated. The direct method above avoids sharing this setup with another bot operator.

## 6. Connect in Threadpost

Open Threadpost’s admin inbox, then open **Settings → Telegram**. Enter:

- **Bot token:** the token from BotFather.
- **Private forum chat ID:** the `-100…` value from step 4.
- **Operator user IDs:** the numeric IDs from step 5, separated by commas or spaces.

Choose **Connect Telegram**. Threadpost checks the token, verifies that the destination is a private supergroup with Topics enabled, verifies the bot is an administrator with **Manage Topics**, checks for another webhook, and registers its own webhook.

When setup succeeds, the status changes to **Connected** and shows the bot username, group ID, and number of allowed operators. Threadpost does not return the saved token to the browser.

If setup fails:

- **Telegram rejected the bot token:** copy the current token from BotFather. Revoke it first if the old value was exposed.
- **Telegram could not access that group / chat not found:** confirm the `-100…` chat ID and add the same bot whose token you entered to the group.
- **Bot must be an administrator allowed to manage topics:** edit the bot’s administrator rights, explicitly enable **Manage Topics**, save, and verify the saved setting.
- **Choose a Telegram supergroup with Topics enabled:** enable Topics in the group settings; do not use a channel.
- **Use a private Telegram group:** remove the group’s public username.
- **Bot already has a webhook configured elsewhere:** use a dedicated bot or disconnect it from the other application before retrying.
- **Could not register the webhook:** confirm `PUBLIC_URL` is the public HTTPS origin that reaches Threadpost.

## 7. Test the first new website conversation

Connecting Telegram preserves conversations already stored in Threadpost, but it does not replay them into Telegram. Only conversations created after the connection get Telegram topics.

1. Open a page containing the Threadpost widget in a fresh private/incognito browser window. This ensures the widget creates a new conversation instead of reopening a stored one.
2. Send a short synthetic message, such as `Testing the new inbox`.
3. Confirm a new topic appears in the private Telegram forum. The topic name includes the configured site and may include a shortened browser-reported page path.
4. In that topic, send a plain-text reply from an account whose numeric ID is in the operator list.
5. Return to the still-open widget. The reply should appear automatically, normally within a few seconds.

Slash commands, messages from unlisted accounts, messages in the wrong group, and bot-authored messages are ignored. An operator reply sent from Threadpost’s browser inbox appears in the visitor widget but is not echoed into Telegram.

Keep the forum private. Telegram bot chats are not end-to-end encrypted, and deleting a conversation from Threadpost does not remove messages already delivered to Telegram.
