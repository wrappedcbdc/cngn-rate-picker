import type { ProviderContext, ProviderQuote, RateProvider } from "../types.js";
import { httpJson, toPrice } from "../http.js";

interface BinanceP2PResponse {
  data?: Array<{ adv?: { price?: string } }>;
}

export interface BinanceP2POptions {
  /** "BUY" = price to buy USDT with NGN, "SELL" = price to sell USDT for NGN. */
  tradeType?: "BUY" | "SELL";
  /** How many top ads to sample before taking the median. */
  rows?: number;
}

/**
 * Binance P2P — UNOFFICIAL and UNSUPPORTED.
 *
 * Binance delisted all NGN spot pairs in March 2024, so the normal spot ticker
 * no longer has USDT/NGN. The only remaining "Binance rate" comes from the P2P
 * marketplace via this internal endpoint, which is undocumented, may rate-limit,
 * change shape, or disappear without notice. It is NOT registered by default —
 * opt in explicitly if you accept that fragility.
 *
 * We take the median of the top ads to blunt outliers/spam listings.
 */
export class BinanceP2PProvider implements RateProvider {
  readonly name = "binance-p2p";
  private readonly tradeType: "BUY" | "SELL";
  private readonly rows: number;

  constructor(
    opts: BinanceP2POptions = {},
    private readonly url = "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
  ) {
    this.tradeType = opts.tradeType ?? "BUY";
    this.rows = opts.rows ?? 5;
  }

  async getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    const body = await httpJson<BinanceP2PResponse>(this.url, {
      ctx,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        asset: "USDT",
        fiat: "NGN",
        tradeType: this.tradeType,
        page: 1,
        rows: this.rows,
      }),
    });

    const prices = (body?.data ?? [])
      .map((ad) => ad?.adv?.price)
      .filter((p): p is string => p !== undefined)
      .map(toPrice)
      .sort((a, b) => a - b);

    if (prices.length === 0) throw new Error("no P2P ads returned");
    const mid = Math.floor(prices.length / 2);
    const median =
      prices.length % 2 === 0
        ? ((prices[mid - 1] as number) + (prices[mid] as number)) / 2
        : (prices[mid] as number);
    return { price: median, raw: body };
  }
}
