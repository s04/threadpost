import type { D1Transport, D1Result } from "./d1-store";

/** The Worker owns the D1 binding; account API credentials never enter the container. */
export function d1Transport(url: string, token: string): D1Transport {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || token.length < 32)
    throw new Error("D1 requires an HTTPS endpoint and a private transport token.");
  return {
    async batch(statements) {
      const response = await fetch(endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json", "x-threadpost-internal": token },
        body: JSON.stringify(statements.map(s => ({ sql: s.sql, params: s.params || [] }))),
      });
      if (!response.ok) throw new Error("Database request failed.");
      const results = await response.json() as (D1Result & { success?: boolean })[];
      if (!Array.isArray(results) || results.length !== statements.length || results.some(r => r.success === false || !Array.isArray(r.results)))
        throw new Error("Invalid database response.");
      return results;
    },
  };
}
