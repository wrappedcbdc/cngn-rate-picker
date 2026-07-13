import type { ProviderContext, ProviderQuote, RateProvider } from "../types.js";
import { httpJson, toPrice } from "../http.js";

interface CoinGeckoSimplePrice {
  tether?: { ngn?: number };
}

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
