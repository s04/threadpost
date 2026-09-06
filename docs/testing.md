# Testing Threadpost

Install dependencies with `bun install --frozen-lockfile`, then install Chromium
once with `bun run browser:install`. On Linux hosts missing browser libraries,
use `bunx playwright-core install --with-deps chromium`. Alternatively set
`CHROMIUM_PATH` to an existing Chromium executable.

## Commands

| Command | Coverage |
| --- | --- |
| `bun run test:unit` | Context normalization, Turnstile validation, runtime authentication/flushing, Telegram error classification and secret redaction. |
| `bun run test:integration` | HTTP handlers, bridge, storage, connector setup, sessions, quotas, delivery recovery, visitor isolation and deletion. Includes SQLite and D1-adapter lifecycle tests. |
| `bun run test:e2e` | Browser smoke and five messaging scenarios, using real widget/admin bundles and local HTTP endpoints. |
| `bun run test:regression` | Delete/recreate integration regressions and all five messaging browser scenarios. |
| `bun run check:all` | Type checking, every Bun test, browser build, browser smoke and all messaging scenarios. Run before publishing. |

Regression describes why a test exists, not a separate execution layer: the same
regressions run as part of integration and browser suites. `bun test` runs all
unit/integration files but does not launch the browser suites. `bun run check`
also type-checks and builds; use `check:all` for complete local validation.

## Messaging browser scenarios

1. A visitor message travels through the Telegram connector, an authenticated
   webhook reply appears automatically in widget and inbox, and selecting the
   same inbox conversation again preserves the displayed messages.
2. Two independent browser contexts keep separate conversations/topics; replies
   cannot cross visitors, another visitor's token is rejected, and unauthorized
   operator replies are ignored.
3. Deleting and recreating a chat gives it a new ID and Telegram topic, removes
   only the deleted history, and preserves another visitor's conversation.
4. A reply to a deleted topic never appears in its replacement conversation;
   a reply to the replacement's topic appears normally.
5. Delayed admin send and delete responses cannot switch or clear a different
   conversation selected while the request was in flight.

The same-conversation redraw and delayed-send assertions failed against the
previous UI, then passed with the fixes. Keep these assertions when changing
polling, request handling or message rendering.

## Boundaries and safety

Tests use synthetic identities, in-memory databases and generated local admin
secrets. They do not read deployment credentials or send real Telegram messages.
The browser suite exercises the D1 adapter over a local transactional SQLite
transport and a simulated Telegram API. It covers the application path, not
Cloudflare's hosted infrastructure, real Turnstile challenges, Telegram client
notification settings, or phone push delivery. Telegram webhooks are submitted
locally with their configured test secret.

Hosted CI remains **manual only** (`workflow_dispatch`); it runs `check:all` when
explicitly started. Local checks do not consume GitHub Actions minutes.
