# Admin sign-in and token recovery

Open `/admin` on your Threadpost backend. Sign in with the `ADMIN_TOKEN` chosen
by whoever deployed it. Threadpost does not generate a default login or email a
recovery link. This is not your Telegram bot token, a Cloudflare API token, or a
visitor conversation token. Anyone with it can administer the entire workspace.

## Find your existing token

- **Password manager:** look for the credential saved when deploying Threadpost.
- **Bun / Docker Compose:** privately open the deployment's `.env` or secret manager and find `ADMIN_TOKEN`. The repository's `.env.example` contains no working token. Avoid dumping environment variables or container configuration into logs or support tickets.
- **Cloudflare:** use the copy you saved before setting the Worker secret. Cloudflare's dashboard and Wrangler do not reveal existing secret values. `wrangler secret list` lists names, not values. See [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
- **Someone else hosts it:** ask that deployment's administrator through a private channel.

There is deliberately no public endpoint that returns the admin token.

## Create a token for a new deployment

Generate a unique random password of at least 32 characters in your password
manager and save it there. Set it as `ADMIN_TOKEN` in your host's secret manager
or private `.env` file. Keep local secret files out of Git and restrict access to
the deployment owner. Do not put the token in URLs or the widget snippet.

For Cloudflare, use the interactive prompt with your actual config path:

```sh
bunx wrangler secret put ADMIN_TOKEN --config path/to/wrangler.jsonc
```

The prompt keeps the value out of shell history. Follow the deployment guide to
start or deploy the application, then sign in with the saved value.

## Lost token or planned rotation

First back up your database and preserve its encryption key. Changing
`ADMIN_TOKEN` invalidates existing admin sessions once the updated application
is running. It does not delete conversations.

### Cloudflare Workers + Containers

Set a new random `ADMIN_TOKEN` with the prompt above, and deploy using the same
configuration. Wait for the container rollout, then sign in with the new token.
**Keep `INTERNAL_TOKEN` unchanged:** it encrypts saved Telegram settings as well
as protecting the internal transport. Rotating it is not an admin-login reset.

### Bun / Docker Compose

Check how your deployment encrypts Telegram settings **before changing the token**:

- If a separate `SETTINGS_KEY` was configured, keep that exact value unchanged.
- If `SETTINGS_KEY` was unset, saved Telegram settings use the old `ADMIN_TOKEN`. If you still have that value, set `SETTINGS_KEY` to the old value before changing `ADMIN_TOKEN`. This preserves the existing encryption key.
- If the old value is lost and there is no separate encryption key, resetting the login alone cannot recover encrypted Telegram settings. Restore the key from a private backup first. Do not delete the database or invent a replacement encryption key as a recovery shortcut.

Update `ADMIN_TOKEN` in the deployment environment. Restart the Bun process, or
run `docker compose up -d` to recreate the container with the new environment.
Keep the same database volume. Sign in with the new token and confirm Telegram
remains connected.

## Session behavior

The default login lasts eight hours. **Keep me signed in for 30 days** is for
trusted devices. Both options survive restarts; background polling does not
extend their expiry. The browser uses an HttpOnly, SameSite=Strict cookie, marked
Secure on HTTPS. Logout revokes that session. This alpha uses a shared workspace
admin token; it does not provide individual accounts, MFA, or per-operator roles.
