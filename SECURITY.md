# Security policy

## Reporting a vulnerability

Please [report a vulnerability privately](https://github.com/s04/threadpost/security/advisories/new).
Do not open a public issue for an undisclosed vulnerability.

Include the affected version, reproduction steps, impact, and any suggested mitigation. Remove access tokens, message contents, database files, and other private data from the report. Maintainers will acknowledge the report, investigate it, and coordinate disclosure and a fix when appropriate.

## Deployment responsibilities

Threadpost is self-hosted software. Operators are responsible for TLS, access controls, host and container updates, database backups, and protecting all configured secrets. Use unique admin and webhook secrets of at least 32 characters. Do not expose the SQLite database or `.env` file through a web server or backup download.

Telegram bot chats are not end-to-end encrypted. Deleting local Threadpost records does not remove copies held by Telegram.
