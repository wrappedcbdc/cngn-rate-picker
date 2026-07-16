import type { ProviderContext, ProviderQuote, RateProvider, UsdStablecoin } from "../types.js";
import { httpJson, toPrice } from "../http.js";

interface QuidaxTickerResponse {
  status: string;
  data?: Record<
    string,
    {
      ticker: {
        high: string | number;
        vol: string | number;
        last: string | number;
        low: string | number;
        buy: string | number;
        sell: string | number;
        open: string | number;
      };
    }
  >;
}

const DEFAULT_BASE_URL = "https://openapi.quidax.io/exchange-open-api/api/v1";

export interface QuidaxProviderOptions {
  /** USD stablecoin side of the cNGN market (default "USDT"). */
  asset?: UsdStablecoin;
  /**
   * Explicit Quidax market id. Defaults to `cngn` + the asset lowercased
   * (e.g. "cngnusdt", "cngnusdc") — the request fails over cleanly if Quidax
   * doesn't list that market.
   */
  market?: string;
  baseUrl?: string;
}

export class QuidaxProvider implements RateProvider {
  readonly name = "quidax";
  readonly asset: UsdStablecoin;
  private readonly market: string;
  private readonly baseUrl: string;

  constructor(options: QuidaxProviderOptions | string = {}) {
    const opts = typeof options === "string" ? { baseUrl: options } : options;
    this.asset = opts.asset ?? "USDT";
    this.market = opts.market ?? `cngn${this.asset.toLowerCase()}`;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  }

  async getPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    const body = await httpJson<QuidaxTickerResponse>(
      `${this.baseUrl}/markets/tickers/${this.market}`,
      { ctx },
    );
    const ticker = body?.data?.[this.market]?.ticker;
    if (!ticker) throw new Error(`unexpected Quidax response shape for market "${this.market}"`);

    // Prefer last-traded price; fall back to the bid/ask mid. Both are
    // <asset>-per-cNGN, so invert to get NGN-per-<asset>.
    let assetPerCngn: number;
    try {
      assetPerCngn = toPrice(ticker.last);
    } catch {
      assetPerCngn = (toPrice(ticker.buy) + toPrice(ticker.sell)) / 2;
    }
    return { price: 1 / assetPerCngn, raw: body };
  }

  /** @deprecated Use {@link getPriceInNgn}; this alias quotes whatever `asset` is configured. */
  getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    return this.getPriceInNgn(ctx);
  }
}
