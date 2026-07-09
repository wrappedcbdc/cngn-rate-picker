import type { ProviderContext } from "./types.js";

export interface HttpJsonOptions {
  /** Provider context carrying the injected fetch and the timeout signal. */
  ctx: ProviderContext;
  /** HTTP method. Default: GET. */
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Minimal JSON HTTP helper shared by all providers. Uses the fetch and abort
 * signal from the provider context so timeouts and injection work uniformly,
 * and throws on any non-2xx response.
 */
export async function httpJson<T>(url: string, options: HttpJsonOptions): Promise<T> {
  const { ctx, method = "GET", headers, body } = options;
  const res = await ctx.fetch(url, { method, headers, body, signal: ctx.signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  }
  return (await res.json()) as T;
}

/**
 * Parse an upstream price (string or number) into the finite, positive number
 * the `ProviderQuote` contract requires. Throws on anything else so a broken
 * payload fails the provider instead of poisoning the rate.
 */
export function toPrice(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid price value: ${JSON.stringify(value)}`);
  }
  return n;
}
