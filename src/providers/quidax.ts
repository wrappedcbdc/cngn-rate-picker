import type { ProviderContext, ProviderQuote, RateProvider, UsdStablecoin } from "../types.js";
import { httpJson, toPrice } from "../http.js";
import { newestPoint, timeWeightedAverage, withinWindow, type PricePoint } from "../twap.js";

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

/** `[timestampMs, open, high, low, close, volume]`, newest first. */
type QuidaxCandle = [number, string | number, string | number, string | number, string | number, string | number];

interface QuidaxKlineResponse {
  status?: string;
  message?: string;
  data?: QuidaxCandle[];
}

const DEFAULT_BASE_URL = "https://openapi.quidax.io/exchange-open-api/api/v1";
/** Candles requested in one kline call. */
const MAX_CANDLES = 1000;

/** `"twap"` averages the kline series; `"spot"` reads the instantaneous ticker. */
export type QuidaxPriceMode = "twap" | "spot";

export interface QuidaxProviderOptions {
  /** USD stablecoin side of the cNGN market (default "USDT"). */
  asset?: UsdStablecoin;
  /**
   * Explicit Quidax market id. Defaults to `cngn` + the asset lowercased
   * (e.g. "cngnusdt", "cngnusdc") — the request fails over cleanly if Quidax
   * doesn't list that market.
   */
  market?: string;
  /**
   * Whether the market quotes the asset per cNGN (so the price needs
   * inverting) rather than NGN per asset. Inferred from the market id — a
   * market starting with the asset symbol (`usdtngn`) is taken as NGN per
   * asset, anything else (`cngnusdt`) as needing inversion — so set this only
   * when the naming doesn't follow that shape.
   */
  invert?: boolean;
  /**
   * Which price to take (default "twap"): a time-weighted average of the kline
   * series, or the instantaneous ticker (`last`, falling back to the bid/ask
   * mid).
   */
  price?: QuidaxPriceMode;
  /** How far back the TWAP looks, in milliseconds (default 1 hour). */
  twapWindowMs?: number;
  /** Kline candle period in minutes (default 1). */
  klinePeriodMinutes?: number;
  /**
   * Reject the series when its newest candle is older than this, in
   * milliseconds (default 6 hours); `false` disables the check. Guards against
   * dormant markets: Quidax keeps serving the last price of a market that has
   * stopped trading, and a months-old number quietly averaged into a
   * settlement rate is worse than no quote at all.
   */
  maxStalenessMs?: number | false;
  baseUrl?: string;
}

/**
 * Live crypto market rate from Quidax.
 *
 * Quotes a TWAP over the public kline series by default, weighting each
 * candle's close by how long it stood as the last price. `price: "spot"` reads
 * the ticker instead — the pre-TWAP behaviour, with no staleness check
 * available since the ticker carries no timestamp.
 *
 * Note the default `cngn<asset>` markets are thin: as of 2026-08-17 `cngnusdt`
 * has not traded in months and `cngnusdc` serves an empty series, so the
 * staleness guard fails this provider over unless you point it at a liquid
 * market (`market: "usdtngn"`, which quotes NGN per USDT directly).
 */
export class QuidaxProvider implements RateProvider {
  readonly name = "quidax";
  readonly asset: UsdStablecoin;
  private readonly market: string;
  private readonly invert: boolean;
  private readonly price: QuidaxPriceMode;
  private readonly twapWindowMs: number;
  private readonly klinePeriodMinutes: number;
  private readonly maxStalenessMs: number | false;
  private readonly baseUrl: string;

  constructor(options: QuidaxProviderOptions | string = {}) {
    const opts = typeof options === "string" ? { baseUrl: options } : options;
    this.asset = opts.asset ?? "USDT";
    this.market = opts.market ?? `${this.asset.toLowerCase()}cngn`;
    // `usdtngn` is NGN per USDT already; `cngnusdt` is USDT per cNGN.
    this.invert = opts.invert ?? !this.market.toLowerCase().startsWith(this.asset.toLowerCase());
    this.price = opts.price ?? "twap";
    this.twapWindowMs = opts.twapWindowMs ?? 3_600_000;
    this.klinePeriodMinutes = opts.klinePeriodMinutes ?? 1;
    this.maxStalenessMs = opts.maxStalenessMs ?? 21_600_000;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;

    if (!Number.isFinite(this.twapWindowMs) || this.twapWindowMs <= 0) {
      throw new Error(
        `twapWindowMs must be a positive number of milliseconds, got ${opts.twapWindowMs}`,
      );
    }
    if (!Number.isInteger(this.klinePeriodMinutes) || this.klinePeriodMinutes < 1) {
      throw new Error(
        `klinePeriodMinutes must be a positive integer, got ${opts.klinePeriodMinutes}`,
      );
    }
  }

  async getPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    if (this.price === "spot") return this.fetchTicker(ctx);

    const now = Date.now();
    const { points, raw } = await this.fetchKline(ctx);
    const newest = newestPoint(points);
    if (!newest) {
      throw new Error(`Quidax returned no kline candles for market "${this.market}"`);
    }
    if (this.maxStalenessMs !== false && now - newest.at > this.maxStalenessMs) {
      const hours = ((now - newest.at) / 3_600_000).toFixed(1);
      throw new Error(
        `Quidax market "${this.market}" is stale: newest candle is ${hours}h old ` +
          `(max ${this.maxStalenessMs}ms) — the market may be dormant`,
      );
    }

    // The series is fresh but may have no candle inside the window on a thin
    // market; the newest close is still the last price that stood.
    const windowed = withinWindow(points, now - this.twapWindowMs);
    const twap = timeWeightedAverage(windowed.length > 0 ? windowed : [newest], now);
    return { price: twap!, raw };
  }

  private async fetchKline(
    ctx: ProviderContext,
  ): Promise<{ points: PricePoint[]; raw: QuidaxKlineResponse }> {
    const candlesNeeded = Math.ceil(this.twapWindowMs / (this.klinePeriodMinutes * 60_000)) + 1;
    const limit = Math.min(Math.max(candlesNeeded, 2), MAX_CANDLES);
    const body = await httpJson<QuidaxKlineResponse>(
      `${this.baseUrl}/markets/${encodeURIComponent(this.market)}/k` +
        `?period=${this.klinePeriodMinutes}&limit=${limit}`,
      { ctx },
    );
    const candles = body?.data;
    if (!Array.isArray(candles)) {
      throw new Error(
        `unexpected Quidax kline response for market "${this.market}"` +
          `${body?.message ? `: ${body.message}` : ""}`,
      );
    }

    const points = candles
      .filter((c) => Array.isArray(c) && c.length >= 5 && Number.isFinite(Number(c[0])))
      .map((c) => {
        // Close is the last price that cleared within the candle.
        const close = toPrice(c[4]);
        return { price: this.invert ? 1 / close : close, at: Number(c[0]) };
      });
    return { points, raw: body };
  }

  private async fetchTicker(ctx: ProviderContext): Promise<ProviderQuote> {
    const body = await httpJson<QuidaxTickerResponse>(
      `${this.baseUrl}/markets/tickers/${this.market}`,
      { ctx },
    );
    const ticker = body?.data?.[this.market]?.ticker;
    if (!ticker) throw new Error(`unexpected Quidax response shape for market "${this.market}"`);

    // Prefer last-traded price; fall back to the bid/ask mid.
    let price: number;
    try {
      price = toPrice(ticker.last);
    } catch {
      price = (toPrice(ticker.buy) + toPrice(ticker.sell)) / 2;
    }
    return { price: this.invert ? 1 / price : price, raw: body };
  }

  /** @deprecated Use {@link getPriceInNgn}; this alias quotes whatever `asset` is configured. */
  getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    return this.getPriceInNgn(ctx);
  }
}
