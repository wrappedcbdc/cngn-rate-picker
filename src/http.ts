import type { ProviderContext } from "./types.js";

export interface HttpJsonOptions {
  ctx: ProviderContext;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export async function httpJson<T>(url: string, options: HttpJsonOptions): Promise<T> {
  const { ctx, method = "GET", headers, body } = options;
  const res = await ctx.fetch(url, { method, headers, body, signal: ctx.signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  }
  return (await res.json()) as T;
}

export function toPrice(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid price value: ${JSON.stringify(value)}`);
  }
  return n;
}
