import type { Config } from "./config";
import { AppError } from "./store";

/** Browser metadata is context, never proof of a visitor's identity. */
export function conversationSource(request: Request, pageUrl: unknown) {
  const origin = request.headers.get("origin");
  let path: string | null = null;
  if (origin && typeof pageUrl === "string" && pageUrl.length <= 4096) {
    try {
      const url = new URL(pageUrl);
      if (url.origin === origin && !url.username && !url.password) path = url.pathname.slice(0, 512);
    } catch { /* Invalid optional metadata is discarded. */ }
  }
  return { origin, path };
}

export function browserContext(referrerUrl: unknown, language: unknown, timezone: unknown) {
  let referrerOrigin: string | null = null;
  if (typeof referrerUrl === "string" && referrerUrl.length <= 2048) {
    try {
      const url = new URL(referrerUrl);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) referrerOrigin = url.origin;
    } catch { /* Invalid optional metadata is discarded. */ }
  }
  const browserLanguage = typeof language === "string" && language.length <= 35
    && /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language) ? language : null;
  const browserTimezone = typeof timezone === "string" && timezone.length <= 80
    && /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(timezone) ? timezone : null;
  return { referrerOrigin, browserLanguage, browserTimezone };
}

export async function verifyHuman(config: Config, token: unknown, origin: string | null, ip: string, transport: typeof fetch = fetch) {
  if (!config.turnstileSecret) return;
  if (typeof token !== "string" || !token || token.length > 2048)
    throw new AppError(403, "Complete the verification before starting a chat.");
  if (!origin || !config.origins.includes(origin)) throw new AppError(403, "A permitted website origin is required.");
  let result: { success?: boolean; hostname?: string; action?: string };
  try {
    const response = await transport("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: config.turnstileSecret, response: token, remoteip: ip }),
    });
    if (!response.ok) throw new Error();
    result = await response.json() as typeof result;
  } catch { throw new AppError(503, "Verification is temporarily unavailable. Please try again."); }
  if (!result.success || result.hostname !== new URL(origin).hostname || result.action !== "start_chat")
    throw new AppError(403, "Verification expired or failed. Please try again.");
}
