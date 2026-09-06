# Contributing to Threadpost

Thank you for helping improve Threadpost.

## Development setup

Install Bun 1.3.10, then run:

```sh
bun install --frozen-lockfile
cp .env.example .env
bun run start
```

Replace the sample `ADMIN_TOKEN` before starting the application. Keep `CONNECTOR=demo` for local development unless you are testing Telegram intentionally.

Before submitting a change, run:

```sh
bun run check
```

## Changes

Keep pull requests focused and explain the behavior they change. Add or update tests when behavior warrants it. Do not commit `.env`, SQLite databases, chat transcripts, bot tokens, webhook secrets, admin tokens, or other private data.

The application deliberately uses Bun's built-in server and SQLite support plus framework-free browser code. Discuss large dependency or architecture changes before investing in them.

## Repository map

- `src/app.ts` defines the HTTP routes and authentication boundaries.
- `src/store.ts` and `src/d1-store.ts` implement local SQLite and hosted D1 persistence.
- `src/bridge.ts` and `src/connectors.ts` own delivery state and provider behavior.
- `src/browser/` contains the authored admin and widget clients. Run `bun run build` after editing them; generated browser JavaScript is intentionally ignored.
- `public/` contains the served HTML and CSS.
- `cloudflare/` contains the optional Worker, Container, and D1 adapter.
- `tests/` contains the Bun test suite.

Use synthetic messages and credentials in tests, screenshots, issues, and pull requests. For behavior that sends externally, test with a mock transport unless the change specifically requires an authorized integration test.

## Pull requests

Describe the user-visible behavior, relevant security or delivery-state effects, and the checks you ran. A pull request should pass `bun run check` and should update documentation when setup or configuration changes.

Report security problems privately as described in [SECURITY.md](SECURITY.md).
