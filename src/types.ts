
/**
 * A USD-backed stablecoin symbol. "USDT" and "USDC" get autocompletion, but
 * any other symbol (e.g. "PYUSD", "FDUSD") is accepted so new stablecoins can
 * be used without a library update — pair them with a provider that has a
 * market for them.
 */
export type UsdStablecoin = "USDT" | "USDC" | (string & {});

/**
 * What a provider quotes. A concrete stablecoin symbol only matches a picker
 * configured for that same symbol; "USD" marks a fiat-USD source (official FX
 * rate) that is a valid proxy for any USD-backed stablecoin and therefore
 * matches every picker.
 */
export type ProviderAsset = UsdStablecoin | "USD";

export type CurrencyCode = "NGN" | UsdStablecoin;

export interface RateSource {
  provider: string;
  price: number;
  raw?: unknown;
  fetchedAt: number;
  usedInAverage: boolean;
}

export interface Rate {
  base: CurrencyCode;
  quote: CurrencyCode;
  rate: number;
  provider: string;
  timestamp: number;
  cached: boolean;
  raw?: unknown;
  sources: RateSource[];
}

export interface ProviderQuote {
  price: number;
  raw?: unknown;
}

export interface ProviderContext {
  signal: AbortSignal;
  fetch: typeof fetch;
}

export interface RateProvider {
  readonly name: string;
  /**
   * Which USD asset this provider quotes. Defaults to "USDT" when omitted.
   * The picker refuses providers whose asset doesn't match its own; "USD"
   * (fiat proxy) matches any picker.
   */
  readonly asset?: ProviderAsset;
  /** Price of 1 unit of {@link asset} in NGN, as a finite positive number. */
  getPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote>;
}

/**
 * The pre-0.2 provider contract, which could only quote USDT.
 *
 * @deprecated Implement {@link RateProvider} (`getPriceInNgn` + optional
 * `asset`) instead. Providers of this shape are treated as quoting USDT.
 */
export interface LegacyRateProvider {
  readonly name: string;
  getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote>;
}

/** Anything the picker accepts as a provider. */
export type AnyRateProvider = RateProvider | LegacyRateProvider;