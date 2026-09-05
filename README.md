# Threadpost

Threadpost is a small, self-hosted inbox for conversations started from a website widget. Visitors write from the embedded widget; operators reply from the local admin interface or, when configured, a private Telegram forum.

Threadpost is an open-source starter for one workspace and one running process. It is not a hosted multi-tenant service.

## Requirements

- [Bun 1.3.10](https://bun.sh/)
- A writable directory for the SQLite database

## Run locally

```sh
cp .env.example .env
```

Set `ADMIN_TOKEN` in `.env` to a unique value of at least 32 characters. Then install dependencies and start the server:

```sh
bun install --frozen-lockfile
bun run start
```

Open `http://localhost:8788` for the demo page or `http://localhost:8788/admin` for the admin inbox. Run the project checks with:

```sh
bun run check
```

The application uses Bun's native SQLite driver. By default, durable state is stored in `data/threadpost.sqlite`.

Use a fresh `DB_PATH` when moving from demo to Telegram, changing the site ID,
or moving to another bot/group. Each database is bound to its workspace and
connector so old conversation threads cannot be routed to a different inbox.

## Embed the widget

Add this script to a page whose exact origin is listed in `ALLOWED_ORIGINS`:

```html
<script src="https://support.example.com/widget.js" data-site="demo" data-title="Chat with us"></script>
```

`data-title` is optional. The widget derives the API address from the script URL. Conversation credentials stay in browser storage scoped to the server and site, and are sent only in authorization headers.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Address the Bun server listens on. Use `0.0.0.0` inside a container. |
| `PORT` | `8788` | HTTP port. |
| `PUBLIC_URL` | `http://localhost:8788` in development | Public base URL used for links, embeds, and the Telegram webhook. |
| `ADMIN_TOKEN` | required | Admin sign-in secret, at least 32 characters. |
| `DB_PATH` | `data/threadpost.sqlite` | SQLite database path. |
| `SITE_ID` | `demo` | Site identifier used by the widget. |
| `SITE_NAME` | `Demo site` | Human-readable site name. |
| `ALLOWED_ORIGINS` | includes `PUBLIC_URL` | Comma-separated exact origins allowed to call the API. Include every page origin that embeds the widget. |
| `CONNECTOR` | `demo` | Connector to use: `demo` or `telegram`. |
| `TELEGRAM_BOT_TOKEN` | empty | Bot token required by the Telegram connector. |
| `TELEGRAM_CHAT_ID` | empty | Negative numeric ID of the private forum supergroup. |
| `TELEGRAM_OPERATOR_IDS` | empty | Comma-separated Telegram user IDs allowed to operate the bot. |
| `TELEGRAM_WEBHOOK_SECRET` | empty | Webhook secret of at least 32 characters, required by the Telegram connector. |

`PUBLIC_URL` must be an origin without a path, query, or fragment. Use exact allowed origins such as `https://www.example.com`, without paths or wildcards. Threadpost always adds `PUBLIC_URL` to the allowed list. In production, serve Threadpost over HTTPS and set `PUBLIC_URL` to that HTTPS origin.

## Docker Compose

Copy `.env.example` to `.env`, set `ADMIN_TOKEN`, then run:

```sh
docker compose up --build -d
```

Compose publishes the service only on `127.0.0.1:8788` and stores SQLite data in the `threadpost-data` volume. Put a TLS-terminating reverse proxy in front of it for public use. To bind a different host port, set `THREADPOST_PORT` before starting Compose.

Back up the volume regularly. For a consistent backup, stop the container before copying the SQLite database.

## Telegram connector

Telegram setup is an explicit operator action:

1. Create a bot with BotFather and keep its token private.
2. Create a private supergroup, enable forum topics, and add the bot as an administrator with permission to manage topics and messages.
3. Set `CONNECTOR=telegram`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_OPERATOR_IDS`, and a unique `TELEGRAM_WEBHOOK_SECRET` of at least 32 characters.
4. Set `PUBLIC_URL` to the public HTTPS origin that reaches Threadpost.
5. Run `bun run src/setup-telegram.ts` once to verify the configuration and register `${PUBLIC_URL}/webhooks/telegram`.

The webhook route authenticates Telegram requests with its secret header. Application startup does not register or change the webhook. Telegram operator IDs are numeric IDs, not usernames.

Messages from the website appear in one forum topic per conversation. Replies sent in Telegram are relayed to the web visitor. Replies sent from the Threadpost admin are stored and delivered directly to the visitor; they are not echoed into Telegram.

## Delivery and privacy limits

Threadpost stores text messages and uses a durable outbox. A send can end with an `unknown` delivery state if the remote service accepted it but the local process could not record the result. Manual retry is available, but retrying an unknown send may create a duplicate.

Bot conversations in Telegram are not end-to-end encrypted. Deleting a conversation in Threadpost deletes only the local records; it does not delete copies already sent to Telegram.

The connector boundary is intended to support more transports later. Matrix and WhatsApp connectors are not implemented.

## Reuse the bridge

`src/library.ts` exports the store, bridge, HTTP handler and connector contract
for other Bun applications. A connector implements `createThread(conversationId)`
and `send(threadId, body)`. Keep provider credentials server-side; a new transport
also needs an authenticated inbound handler that resolves its thread to exactly
one conversation. The Telegram adapter is the reference implementation.

This starter supports text only and lists the latest 200 conversations in the
panel. Visitor credentials expire after 30 days; stored conversations are not
automatically deleted. Operator sessions expire after eight hours or restart.
Rate limits are per process (five new conversations per IP per minute, 30
messages per conversation per minute). Behind a proxy, clients currently share
the proxy IP; forwarded IP headers are deliberately not trusted. Public hosted
use needs an abuse-control and retention design suited to its traffic.

Every permitted operator's plain-text topic message is a public reply to the
visitor. Slash commands, including `/note`, are ignored. Keep the forum private
and admit operators only: topics do not provide separate membership boundaries.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidance. Please report vulnerabilities according to [SECURITY.md](SECURITY.md).

## License

Threadpost is available under the [MIT License](LICENSE).
