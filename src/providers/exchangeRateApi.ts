import type { ProviderContext, ProviderQuote, RateProvider } from "../types.js";
import { httpJson, toPrice } from "../http.js";

interface ErApiResponse {
  result: string;
  rates: Record<string, number>;
}

/**
 * Official USD→NGN rate. Declares `asset: "USD"`, so it's accepted by a
 * picker configured for any USD-backed stablecoin — the fiat rate is the
 * proxy, on the assumption the coin holds its peg.
 */
export class ExchangeRateApiProvider implements RateProvider {
  readonly name = "exchangerate-api";
  readonly asset = "USD" as const;

  constructor(private readonly baseUrl = "https://open.er-api.com/v6") {}

  async getPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    const body = await httpJson<ErApiResponse>(`${this.baseUrl}/latest/USD`, { ctx });
    if (body?.result !== "success") throw new Error("ExchangeRate-API returned an error result");
    const value = body?.rates?.NGN;
    if (value === undefined) throw new Error("NGN missing from ExchangeRate-API response");
    return { price: toPrice(value), raw: body };
  }

  /** @deprecated Use {@link getPriceInNgn}. */
  getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    return this.getPriceInNgn(ctx);
  }
}
