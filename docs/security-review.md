# Security review

Review date: 2026-09-06. This is a source review with regression tests and local
deployment checks, not an independent penetration-test certification.

## Scope

The review covered admin cookies and session persistence, request origins,
visitor token isolation, message rendering, Telegram setup and webhook
authentication, SQLite and D1 storage, delivery recovery, request quotas,
Cloudflare routing, container configuration, and repository publication hygiene.

## Findings fixed

| Finding | Resolution |
| --- | --- |
| Local SQLite files could inherit permissions that let other OS users read messages and session hashes. | Restrict the database and its WAL/SHM files to the owning user; regression coverage checks file modes. |
| A public HTTP embedding origin allowed browser credentials and messages to be exposed to network modification. | Require HTTPS embedding origins except loopback development hosts. |
| Compose omitted the configured Turnstile keys and daily limits. | Pass protection settings through to the container and verify the rendered Compose configuration with synthetic values. |
| CI action tags could move, and checkout left credentials available to later steps. | Pin action commits, disable persisted checkout credentials, and cap job duration. CI remains manually dispatched. |

## Boundaries checked

- Admin sessions use opaque random tokens, with only keyed hashes persisted in
  storage. Cookies are HttpOnly, SameSite=Strict, and Secure over HTTPS. Logout
  revokes the session; rotating the admin token invalidates existing sessions.
- Visitor access requires a conversation-specific bearer token. Supplied browser
  origins are checked; a missing Origin on a read is not treated as proof of a
  trusted client. Browser source context is not a verified visitor identity.
- Operator mutations require the configured origin. Visitor-provided text is
  rendered as text, without treating it as HTML.
- Telegram replies require the webhook secret, configured group, allowed operator
  ID, and a known topic. Bot credentials remain server-side and are encrypted
  when saved through Settings.
- The Worker replaces client-supplied internal routing headers. The D1 proxy
  requires its private credential, has no browser CORS access, and bounds batches.
- Request bodies, message length, conversation size, creation rates, and message
  rates are bounded. Turnstile must be configured for a public deployment.
- Stable message IDs deduplicate client retries. Ambiguous external sends are
  never automatically retried.

## Publication checks

The reachable Git history was scanned for deployment secrets, private project
identifiers, private file paths, provider-token patterns, and private keys.
No matches were found. Repository images were inspected and contain fictional
local demo data. Dependency auditing reported no known advisories for the
resolved dependency set at review time. These checks do not prove that unknown
vulnerabilities are absent.

## Remaining operational risks

- Message content is plaintext in the database. Filesystem permissions do not
  protect against compromise of the host, process, or database account.
- The private D1 transport grants the container database access for its workspace;
  it is not a boundary against a compromised container.
- Telegram copies remain after local deletion. Telegram bot conversations are
  not end-to-end encrypted.
- Manually retrying an uncertain external send can duplicate a message. Review
  the destination before retrying.
- Telegram webhook registration precedes saving the encrypted settings. A crash
  or database failure between those operations can interrupt inbound delivery;
  reconnecting the same bot/group repairs the setup.
- Blocking is conversation-specific. Anonymous visitors can create another
  conversation, subject to configured challenges and quotas.
- Operators must arrange database backups and retention. There is no automatic
  deletion schedule, high-availability failover, or independently verified
  security assurance.

See [SECURITY.md](../SECURITY.md) for private reporting and deployment responsibilities.

## Admin-access documentation follow-up

The follow-up reviewed the current session/origin checks, Turnstile validation,
Telegram settings encryption, and Worker routing. Added token-recovery guidance
and a login-screen link, including preservation of the encryption key during
admin-token rotation. Refreshed the homepage snippet with supported appearance
options. This was a focused follow-up, not a new independent full audit.

Validation: 57 tests passed, browser smoke passed, and `bun audit` reported no
known vulnerabilities. Read-only live checks confirmed an unauthenticated admin
overview returns 401 and `/.env` returns 404. Public widget configuration exposed
a sitekey; this alone does not prove a complete challenge round trip.
The shared admin credential has no MFA or individual operator accounts.
