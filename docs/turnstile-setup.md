# Protect new chats with Cloudflare Turnstile

Turnstile helps limit automated chat creation before messages reach your inbox.
Threadpost renders the challenge and verifies its result on the server, including
its hostname and `start_chat` action. Existing authenticated conversations do not
need another challenge. Rate limits and daily quotas still apply; Turnstile does
not guarantee that every visitor is human or stop all spam.

## 1. Create a widget

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com/), select your account, and open **Turnstile**.
2. Choose **Add widget**, give it a recognizable name, and select **Managed** mode.
3. Add the website hostnames where visitors will use the chat, such as `example.com` and `www.example.com`. Enter hostnames, without `https://`, paths, or ports. If you use the backend's own demo page, allow that hostname too.
4. Create the widget and copy its **sitekey** and **secret key**. The sitekey is public; the secret is for the backend only.

Your website does not need to use Cloudflare DNS or hosting. Turnstile hostname
management and Threadpost's `ALLOWED_ORIGINS` are separate: the latter needs exact
origins, for example `https://example.com,https://www.example.com`.

See Cloudflare's [getting started guide](https://developers.cloudflare.com/turnstile/get-started/)
and [hostname rules](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/).

## 2. Configure the deployment

These are deployment settings, not editable dashboard fields. Configure both
keys together. Threadpost rejects an incomplete pair at startup. Leaving both
unset disables Turnstile verification; use that only for local development.
Never commit real secrets or paste the secret into a snippet, screenshot, or issue.

### Docker Compose or a Bun server

Set these values in your private `.env` file or your host's secret manager:

```dotenv
TURNSTILE_SITE_KEY=YOUR_PUBLIC_SITEKEY
TURNSTILE_SECRET_KEY=YOUR_PRIVATE_SECRET
ALLOWED_ORIGINS=https://example.com,https://www.example.com
```

For the repository's Compose setup, run `docker compose up -d --build` to apply
the environment. For a Bun process, restart it with the updated environment.
Preserve your existing database volume and other secrets.

### Cloudflare Workers + Containers

In your deployment's Wrangler configuration, add `TURNSTILE_SITE_KEY` to `vars`
and set `ALLOWED_ORIGINS` to the embedding website origins. Store the private key
as a Worker secret using your actual configuration path:

```sh
bunx wrangler secret put TURNSTILE_SECRET_KEY --config path/to/wrangler.jsonc
bunx wrangler deploy --config path/to/wrangler.jsonc
```

The first command prompts for the secret without putting it in shell history.
Threadpost passes the keys from the Worker into its container. Wait for the
container rollout to finish before testing. Keep existing encryption keys and
other deployment secrets unchanged.

## 3. Check it in the browser

1. Open an allowed website in a private browser window, then open the chat widget.
2. Let verification finish. Managed mode may complete without asking you to click.
3. Start a new conversation and confirm it arrives in your inbox. This sends a real message to your connected provider.
4. Try a follow-up message: an existing conversation should not ask for another challenge.

No extra Turnstile script or key attribute is needed in your embed snippet.
Threadpost retrieves the public sitekey from `/api/widget-config?siteId=YOUR_SITE_ID` and loads the
challenge itself. A saved conversation bypasses new-chat verification, so use
**New chat** or a private window when checking setup.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No challenge in a new conversation | Confirm both keys reached the running deployment and `/api/widget-config?siteId=YOUR_SITE_ID` returns a non-null `turnstileSiteKey`. A public sitekey alone does not prove server verification works. |
| “Configure both Turnstile keys together” | Supply the matching sitekey and secret, then restart or redeploy. |
| “Complete the verification before starting a chat” | Wait for the challenge to finish. Check whether a browser extension or network filter blocks `challenges.cloudflare.com`. |
| “Verification expired or failed” | Retry verification; check the key pair, allowed hostname, and exact `ALLOWED_ORIGINS`. Custom integrations must use action `start_chat`. |
| “Verification is temporarily unavailable” | The backend could not complete Cloudflare verification. Retry later and check backend connectivity; do not disable protection as a workaround. |
| Widget blocked by your site's Content Security Policy | Allow `https://challenges.cloudflare.com` in `script-src` and `frame-src`, and allow your Threadpost backend in `connect-src`. Review Cloudflare's CSP guide for your policy. |

Tokens expire after five minutes and can be verified only once. Do not reuse
proof tokens across new conversations. See [server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/),
[client error codes](https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/),
and [CSP configuration](https://developers.cloudflare.com/turnstile/reference/content-security-policy/).

## Local testing and privacy

For local Threadpost development, leave both keys unset. Cloudflare also offers
[test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/),
but its dummy verification responses do not exercise Threadpost's strict hostname
and action checks like a real widget does. Use a separate real widget on an
explicitly allowed development hostname for an end-to-end integration check;
never use test keys in production.

The visitor's browser contacts Cloudflare to perform verification. The backend
also sends the proof and request IP to Cloudflare's verification endpoint. The IP
is not included in the Telegram visitor summary. Account for this third-party
service in your site's privacy information.
