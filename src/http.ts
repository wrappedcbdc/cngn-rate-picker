import type { ProviderContext } from "./types.js";

export interface HttpJsonOptions {
  ctx: ProviderContext;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** What each low-level network error code actually means for a caller. */
const CAUSE_HINTS: Record<string, string> = {
  ENOTFOUND: "host did not resolve (DNS); the domain may be blocked by your resolver or network",
  EAI_AGAIN: "DNS lookup timed out or failed temporarily",
  ECONNREFUSED: "connection refused; nothing is listening on that host/port",
  ECONNRESET: "connection reset by the peer mid-request",
  ETIMEDOUT: "connection timed out",
  UND_ERR_CONNECT_TIMEOUT: "connection timed out before the request was sent",
  UND_ERR_HEADERS_TIMEOUT: "the host accepted the connection but never sent response headers",
  EPROTO: "TLS handshake failed",
  CERT_HAS_EXPIRED: "the host's TLS certificate has expired",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the host's TLS certificate chain could not be verified",
  DEPTH_ZERO_SELF_SIGNED_CERT: "the host presented a self-signed TLS certificate",
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * `fetch` rejects with a bare "fetch failed" and buries the real reason in
 * `cause`, which makes a DNS block or a refused connection indistinguishable
 * from any other outage in provider error output. This unwraps it into
 * something actionable.
 */
export function describeFetchFailure(err: unknown, url: string): string {
  const error = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return `request to ${hostOf(url)} aborted: ${error.message ?? "timed out"}`;
  }
  const code = error?.cause?.code;
  const detail = code ?? error?.cause?.message;
  const hint = code ? CAUSE_HINTS[code] : undefined;
  const base = `${error?.message ?? "fetch failed"} for ${hostOf(url)}`;
  if (!detail) return base;
  return hint ? `${base}: ${detail} — ${hint}` : `${base}: ${detail}`;
}

/** Runs a fetch, re-throwing network failures with the underlying cause spelled out. */
export async function fetchOrDescribe(
  url: string,
  init: RequestInit,
  ctx: ProviderContext,
): Promise<Response> {
  try {
    return await ctx.fetch(url, { ...init, signal: ctx.signal });
  } catch (err) {
    // `cause` is set by hand rather than via the Error options bag, which
    // needs a lib newer than this package targets.
    const wrapped = new Error(describeFetchFailure(err, url));
    (wrapped as { cause?: unknown }).cause = err;
    throw wrapped;
  }
}

export async function httpJson<T>(url: string, options: HttpJsonOptions): Promise<T> {
  const { ctx, method = "GET", headers, body } = options;
  const res = await fetchOrDescribe(url, { method, headers, body }, ctx);
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
