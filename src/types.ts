
export type CurrencyCode = "NGN" | "USDT";

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
  getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote>;
}
