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

Report security problems privately as described in [SECURITY.md](SECURITY.md).
