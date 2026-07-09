/**
 * The only two currencies this library deals with.
 * USDT is treated as the "dollar" leg (it's pegged ~1:1 to USD).
 */
export type CurrencyCode = "NGN" | "USDT";

/**
 * A fully resolved exchange rate produced by the picker.
 * Semantics: `1 <base>` is worth `rate <quote>`.
 */
export interface Rate {
  base: CurrencyCode;
  quote: CurrencyCode;
  /** 1 unit of `base` expressed in `quote`. */
  rate: number;
  /** Name of the provider that supplied the number. */
  provider: string;
  /** When the rate was fetched (ms since epoch). */
  timestamp: number;
  /** True when served from the in-memory cache rather than a live call. */
  cached: boolean;
  /** Original upstream payload, kept for debugging/auditing. */
  raw?: unknown;
}

/**
 * What every provider returns. The canonical unit across the whole library
 * is "how many NGN you get for 1 USDT", so providers only ever have to
 * report that single number. The picker derives both directions from it.
 */
export interface ProviderQuote {
  /** NGN per 1 USDT. Must be a finite, positive number. */
  price: number;
  /** Original upstream payload. */
  raw?: unknown;
}

/**
 * Context handed to a provider on every call. Injecting `fetch` (rather than
 * importing it inside each provider) keeps providers pure and trivially
 * testable, and lets consumers swap in a proxy/instrumented fetch.
 */
export interface ProviderContext {
  /** Aborts when the per-provider timeout elapses. */
  signal: AbortSignal;
  fetch: typeof fetch;
}

/**
 * The Strategy interface. Each upstream API (Quidax, CoinGecko, ...) is one
 * implementation that adapts its own response shape to `ProviderQuote`.
 */
export interface RateProvider {
  /** Stable, human-readable id used in logs, events and the `Rate.provider` field. */
  readonly name: string;
  /** Fetch the current USDT→NGN price. Throw on any failure. */
  getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote>;
}
