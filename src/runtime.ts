import { timingSafeEqual } from "node:crypto";
import type { Bridge } from "./bridge";
import { hash } from "./store";

export type PublicHandler = (request: Request, ip: string) => Promise<Response>;

export function createRuntimeHandler(options: {
  handler: PublicHandler;
  bridge: Pick<Bridge, "flush">;
  useD1: boolean;
  internalToken: string;
  onFlushError?: () => void;
}) {
  const onFlushError = options.onFlushError || (() => console.error("Threadpost delivery flush failed."));
  return async (request: Request, directIp = "unknown"): Promise<Response> => {
    if (options.internalToken && !timingSafeEqual(
      Buffer.from(hash(request.headers.get("x-threadpost-internal") || "")),
      Buffer.from(hash(options.internalToken)),
    )) return new Response("Not found", { status: 404 });

    const ip = options.internalToken
      ? request.headers.get("x-threadpost-client-ip") || "unknown"
      : directIp;
    const response = await options.handler(request, ip);
    if (options.useD1 && request.method !== "OPTIONS") {
      try { await options.bridge.flush(); }
      catch { onFlushError(); }
    }
    return response;
  };
}
