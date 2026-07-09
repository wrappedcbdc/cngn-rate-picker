import type { ProviderContext, ProviderQuote, RateProvider } from "../types.js";
import { httpJson, toPrice } from "../http.js";

interface ErApiResponse {
  result: string;
  rates: Record<string, number>;
}

/**
 * ExchangeRate-API (open, key-less endpoint). Returns the *official* USD→NGN
 * rate, used here as a proxy for USDT (USDT ≈ USD).
 *
 * Caveat: this is the interbank/official rate, which in Nigeria can sit well
 * below the crypto/parallel market rate. Treat this as a last-resort fallback
 * so your app degrades to *a* number rather than failing outright — not as a
 * source of truth for the street rate.
 *
 * Docs: https://www.exchangerate-api.com/docs/free
 */
export class ExchangeRateApiProvider implements RateProvider {
  readonly name = "exchangerate-api";

  constructor(private readonly baseUrl = "https://open.er-api.com/v6") {}

  async getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    const body = await httpJson<ErApiResponse>(`${this.baseUrl}/latest/USD`, { ctx });
    if (body?.result !== "success") throw new Error("ExchangeRate-API returned an error result");
    const value = body?.rates?.NGN;
    if (value === undefined) throw new Error("NGN missing from ExchangeRate-API response");
    return { price: toPrice(value), raw: body };
  }
}
