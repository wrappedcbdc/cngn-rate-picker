import type { ProviderContext, ProviderQuote, RateProvider, UsdStablecoin } from "../types.js";
import { httpJson, toPrice } from "../http.js";
import { timeWeightedAverage, withinWindow, type PricePoint } from "../twap.js";

type CoinGeckoSimplePrice = Record<string, { ngn?: number }>;

interface CoinGeckoMarketChart {
  /** `[timestampMs, price]`, oldest first. */
  prices?: [number, number][];
}

/** CoinGecko coin ids for the stablecoins we know out of the box. */
const COIN_IDS: Record<string, string> = {
  USDT: "tether",
  USDC: "usd-coin",
};

const DAY_MS = 86_400_000;

/** `"twap"` averages the market chart; `"spot"` reads the instantaneous price. */
export type CoinGeckoPriceMode = "twap" | "spot";

export interface CoinGeckoProviderOptions {
  /** USD stablecoin to price in NGN (default "USDT"). */
  asset?: UsdStablecoin;
  /**
   * CoinGecko coin id (the `ids` query parameter). Required for assets
   * without a built-in mapping; overrides the mapping when provided.
   */
  coinId?: string;
  /**
   * Which price to take (default "twap"): a time-weighted average of the
   * `/market_chart` series, or the instantaneous `/simple/price` value.
   */
  price?: CoinGeckoPriceMode;
  /** How far back the TWAP looks, in milliseconds (default 1 hour). */
  twapWindowMs?: number;
  /**
   * Fall back to the instantaneous `/simple/price` when the chart has no
   * points in the window (default "spot"). `false` throws instead.
   */
  twapFallback?: "spot" | false;
  baseUrl?: string;
}

/**
 * Aggregated market rate from CoinGecko.
 *
 * Quotes a TWAP over `/coins/{id}/market_chart` by default — CoinGecko serves
 * that series at 5-minute granularity for a 1-day range — and can read the
 * instantaneous `/simple/price` instead via `price: "spot"`.
 */
export class CoinGeckoProvider implements RateProvider {
  readonly name = "coingecko";
  readonly asset: UsdStablecoin;
  private readonly coinId: string;
  private readonly price: CoinGeckoPriceMode;
  private readonly twapWindowMs: number;
  private readonly twapFallback: "spot" | false;
  private readonly baseUrl: string;

  constructor(options: CoinGeckoProviderOptions | string = {}) {
    const opts = typeof options === "string" ? { baseUrl: options } : options;
    this.asset = opts.asset ?? "USDT";
    const coinId = opts.coinId ?? COIN_IDS[this.asset];
    if (!coinId) {
      throw new Error(
        `no built-in CoinGecko coin id for "${this.asset}"; pass { coinId } explicitly ` +
          `(known assets: ${Object.keys(COIN_IDS).join(", ")})`,
      );
    }
    this.coinId = coinId;
    this.price = opts.price ?? "twap";
    this.twapWindowMs = opts.twapWindowMs ?? 3_600_000;
    this.twapFallback = opts.twapFallback ?? "spot";
    this.baseUrl = opts.baseUrl ?? "https://api.coingecko.com/api/v3";

    if (!Number.isFinite(this.twapWindowMs) || this.twapWindowMs <= 0) {
      throw new Error(
        `twapWindowMs must be a positive number of milliseconds, got ${opts.twapWindowMs}`,
      );
    }
  }

  async getPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    if (this.price === "spot") return this.fetchSpot(ctx);

    const now = Date.now();
    const chart = await this.fetchChart(ctx, now);
    const twap = timeWeightedAverage(withinWindow(chart.points, now - this.twapWindowMs), now);
    if (twap !== null) return { price: twap, raw: chart.raw };

    if (this.twapFallback === false) {
      throw new Error(
        `CoinGecko chart for "${this.coinId}" has no points in the last ${this.twapWindowMs}ms`,
      );
    }
    const spot = await this.fetchSpot(ctx);
    return { price: spot.price, raw: { twapFellBackTo: "spot", chart: chart.raw, spot: spot.raw } };
  }

  private async fetchChart(
    ctx: ProviderContext,
    nowMs: number,
  ): Promise<{ points: PricePoint[]; raw: CoinGeckoMarketChart }> {
    // `days` drives granularity (1 day → 5-minutely), and the endpoint has no
    // arbitrary from/to on the free tier, so fetch whole days and window the
    // series ourselves.
    const days = Math.max(1, Math.ceil(this.twapWindowMs / DAY_MS));
    const body = await httpJson<CoinGeckoMarketChart>(
      `${this.baseUrl}/coins/${encodeURIComponent(this.coinId)}/market_chart` +
        `?vs_currency=ngn&days=${days}`,
      { ctx, headers: { accept: "application/json" } },
    );
    const prices = body?.prices;
    if (!Array.isArray(prices)) {
      throw new Error(`unexpected CoinGecko market chart response for "${this.coinId}"`);
    }

    const points = prices
      .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number(p[1]) > 0)
      .map(([at, price]) => ({ price: Number(price), at: Number(at) }))
      // A point stamped in the future would swallow the whole weight.
      .filter((p) => p.at <= nowMs);
    return { points, raw: body };
  }

  private async fetchSpot(ctx: ProviderContext): Promise<ProviderQuote> {
    const body = await httpJson<CoinGeckoSimplePrice>(
      `${this.baseUrl}/simple/price?ids=${encodeURIComponent(this.coinId)}&vs_currencies=ngn`,
      { ctx, headers: { accept: "application/json" } },
    );
    const value = body?.[this.coinId]?.ngn;
    if (value === undefined) {
      throw new Error(`${this.asset}/NGN (id "${this.coinId}") missing from CoinGecko response`);
    }
    return { price: toPrice(value), raw: body };
  }

  /** @deprecated Use {@link getPriceInNgn}; this alias quotes whatever `asset` is configured. */
  getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    return this.getPriceInNgn(ctx);
  }
}
