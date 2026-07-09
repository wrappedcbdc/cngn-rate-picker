import type { ProviderContext, ProviderQuote, RateProvider } from "../types.js";
import { httpJson, toPrice } from "../http.js";

interface CoinGeckoSimplePrice {
  tether?: { ngn?: number };
}

/**
 * CoinGecko — free, key-less "simple price" endpoint. Returns the aggregated
 * market price of Tether (USDT) denominated in NGN. Good, independent second
 * source. Public tier is rate-limited, so keep it as a fallback, not a hot path.
 *
 * Docs: https://www.coingecko.com/en/api/documentation
 */
export class CoinGeckoProvider implements RateProvider {
  readonly name = "coingecko";

  constructor(private readonly baseUrl = "https://api.coingecko.com/api/v3") {}

  async getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    const body = await httpJson<CoinGeckoSimplePrice>(
      `${this.baseUrl}/simple/price?ids=tether&vs_currencies=ngn`,
      { ctx, headers: { accept: "application/json" } },
    );
    const value = body?.tether?.ngn;
    if (value === undefined) throw new Error("USDT/NGN missing from CoinGecko response");
    return { price: toPrice(value), raw: body };
  }
}
