import type { ProviderContext, ProviderQuote, RateProvider } from "../types.js";
import { httpJson, toPrice } from "../http.js";

interface QuidaxTickerResponse {
  status: string;
  data: {
    ticker: {
      last: string;
      buy: string;
      sell: string;
    };
  };
}

/**
 * Quidax — a Nigerian exchange with a live USDT/NGN spot market and a public,
 * key-less ticker endpoint. This is the closest thing to a real-time
 * "market" naira rate and is the recommended primary provider.
 *
 * Docs: https://docs.quidax.io
 */
export class QuidaxProvider implements RateProvider {
  readonly name = "quidax";

  constructor(private readonly baseUrl = "https://www.quidax.io/api/v1") {}

  async getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    const body = await httpJson<QuidaxTickerResponse>(
      `${this.baseUrl}/markets/usdtngn/ticker`,
      { ctx },
    );
    const ticker = body?.data?.ticker;
    if (!ticker) throw new Error("unexpected Quidax response shape");

    // Prefer last-traded price; fall back to the bid/ask mid.
    let price: number;
    try {
      price = toPrice(ticker.last);
    } catch {
      price = (toPrice(ticker.buy) + toPrice(ticker.sell)) / 2;
    }
    return { price, raw: body };
  }
}
