# Public alpha readiness

Reviewed on 2026-09-06. Threadpost is ready for a public **self-hosted alpha**
focused on one workspace, text conversations, and Telegram. It is early software;
operators should test it with their own infrastructure before depending on it.

## Included in the alpha

| Capability | State |
| --- | --- |
| Embeddable widget with configurable appearance | Included |
| Browser inbox and automatic message updates | Included; polling rather than WebSockets |
| Telegram topic per conversation and operator replies | Included; bot/group setup required |
| Visitor isolation and persistent admin sessions | Included; 8 hours or an explicit 30-day choice |
| Unread indicators and browser notifications | Included; notifications require an open page and permission |
| Close, reopen, block, and delete conversations | Included; provider copies remain after local deletion |
| Duplicate-send protection and delivery recovery | Included; uncertain provider sends need manual review |
| Origin checks, request limits, and anti-bot challenge | Included; configure Turnstile for public traffic |
| SQLite and Cloudflare D1 storage | Included |
| Docker and Cloudflare deployment paths | Included |
| TypeScript connector and storage interfaces | Included; server composition uses Bun |
| Contributor guidance, issue forms, and security reporting policy | Included |

## Review improvements

The security pass tightened local database permissions, required secure public
embedding origins, fixed missing Compose protection settings, and pinned CI
actions. See the [security review](security-review.md) for boundaries and residual risks.

The product pass added first-run inbox guidance, improved mobile controls and
accessible notification state, fixed the demo button under the content security
policy, clarified setup instructions, and added contribution templates. A
repeatable browser smoke test now covers the primary conversation flow.

## Validation

- TypeScript checks for the application and Cloudflare Worker.
- 54 automated tests covering authentication, storage, limits, Telegram transport
  mocks, delivery recovery, and configuration.
- A real Chromium smoke test against an isolated in-memory demo: login, demo
  opener, automatic replies, blocking, deletion, mobile fit, and CSP violations.
- Clean-checkout installation and build, plus local Docker startup checks.
- Dependency audit and reachable-history publication scan.

The Telegram transport tests use simulated provider responses. This review did
not send a message through a live Telegram account. A maintainer should confirm
a real round trip after connecting their own bot. GitHub checks are manually
dispatched; the badge reflects the latest run, not automatic coverage of every commit.

## Next priorities

1. Simplify Telegram setup further, especially discovering group and operator IDs.
2. Add explicit retention controls and convenient conversation export.
3. Split the large browser modules as the UI grows; expand browser tests for
   notifications, reconnection, and accessibility across engines.
4. Add attachments and typing indicators if customer discovery supports them.

Multi-app tenant isolation, operator accounts/roles, WhatsApp and Matrix adapters,
closed-browser Web Push, billing, and high-availability hosting are separate
projects. They are not prerequisites for the advertised single-workspace alpha,
and they are not currently implemented. The package is not published to npm;
reuse the source or a local path dependency.
