import type { ProviderContext, ProviderQuote, RateProvider } from "../types.js";
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

const MARKET = "cngnusdt";

export class QuidaxProvider implements RateProvider {
  readonly name = "quidax";

  constructor(
    private readonly baseUrl = "https://openapi.quidax.io/exchange-open-api/api/v1",
  ) {}

  async getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    const body = await httpJson<QuidaxTickerResponse>(
      `${this.baseUrl}/markets/tickers/${MARKET}`,
      { ctx },
    );
    const ticker = body?.data?.[MARKET]?.ticker;
    if (!ticker) throw new Error("unexpected Quidax response shape");

    // Prefer last-traded price; fall back to the bid/ask mid. Both are
    // USDT-per-cNGN, so invert to get NGN-per-USDT.
    let usdtPerCngn: number;
    try {
      usdtPerCngn = toPrice(ticker.last);
    } catch {
      usdtPerCngn = (toPrice(ticker.buy) + toPrice(ticker.sell)) / 2;
    }
    return { price: 1 / usdtPerCngn, raw: body };
  }
}
