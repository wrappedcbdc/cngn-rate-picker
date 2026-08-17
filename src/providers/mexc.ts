import type { ProviderContext, ProviderQuote, RateProvider, UsdStablecoin } from "../types.js";
import { fetchOrDescribe, toPrice } from "../http.js";
import { newestPoint, timeWeightedAverage, withinWindow, type PricePoint } from "../twap.js";

/** `GET /api/v3/ticker/bookTicker` for one symbol. */
interface MexcBookTicker {
  symbol: string;
  bidPrice: string | number;
  bidQty: string | number;
  askPrice: string | number;
  askQty: string | number;
}

/** `[openTime, open, high, low, close, volume, closeTime, quoteVolume]`, oldest first. */
type MexcCandle = [
  number,
  string | number,
  string | number,
  string | number,
  string | number,
  string | number,
  number?,
  (string | number)?,
];

/** `GET /api/v3/ticker/price` for one symbol. */
interface MexcPriceTicker {
  symbol: string;
  price: string | number;
}

interface MexcError {
  msg?: string;
  code?: number;
}

const DEFAULT_BASE_URL = "https://api.mexc.com";
/** `limit` ceiling on the klines endpoint. */
const MAX_CANDLES = 1000;

/**
 * Which price to quote. `"twap"` averages the kline series, `"last"` reads
 * `/api/v3/ticker/price`, and `"mid"`/`"bid"`/`"ask"` read
 * `/api/v3/ticker/bookTicker`.
 */
export type MexcPriceField = "twap" | "last" | "mid" | "bid" | "ask";

/** Spot field used when the TWAP window holds no candle. */
export type MexcTwapFallback = Exclude<MexcPriceField, "twap"> | false;

export interface MexcProviderOptions {
  /** USD stablecoin side of the market (default "USDT"). */
  asset?: UsdStablecoin;
  /**
   * Quote currency of the market (default "NGN"). MEXC symbols are
   * `<base><quote>` with no separator, so this pairs with `asset` to form the
   * symbol.
   */
  quote?: string;
  /** Explicit symbol, overriding `asset` + `quote` (e.g. "USDTNGN"). */
  symbol?: string;
  /**
   * Whether the symbol quotes the asset per unit of the quote currency (so the
   * price needs inverting) rather than quote-per-asset. Inferred from the
   * symbol: one starting with the asset (`USDTNGN`) is read as NGN per asset,
   * anything else (`NGNUSDT`) as needing inversion.
   */
  invert?: boolean;
  /**
   * Which price to take (default "twap"): a time-weighted average of the kline
   * series, or a field from the order book ticker.
   */
  price?: MexcPriceField;
  /** How far back the TWAP looks, in milliseconds (default 1 hour). */
  twapWindowMs?: number;
  /** Kline interval, in MEXC's notation (default "1m"). */
  klineInterval?: string;
  /**
   * Order-book field to fall back on when no candle falls in the window
   * (default "mid"); `false` throws instead.
   */
  twapFallback?: MexcTwapFallback;
  /**
   * Reject the series when its newest candle is older than this, in
   * milliseconds (default 6 hours); `false` disables the check. Thinly traded
   * listings can go hours between candles, and a stale print averaged into a
   * settlement rate is worse than no quote.
   */
  maxStalenessMs?: number | false;
  baseUrl?: string;
}

/**
 * Spot market rate from MEXC.
 *
 * Quotes a TWAP over `GET /api/v3/klines` by default, weighting each candle's
 * close by how long it stood as the last price. `price` switches to a spot
 * read: `"last"` uses `GET /api/v3/ticker/price` (a single scalar, the closest
 * match to this library's one-number contract) and `"mid"`/`"bid"`/`"ask"` use
 * `GET /api/v3/ticker/bookTicker`. The same fields serve as the empty-window
 * fallback.
 *
 * ⚠️ **MEXC lists no NGN or cNGN market.** As of 2026-08-17 none of its 2102
 * spot symbols contains "NGN", so the default `USDTNGN` symbol returns
 * `-1121 invalid symbol` and this provider fails over. It is wired up and
 * tested so it starts working the moment such a pair is listed; until then
 * point it at a symbol that exists (`symbol: "USDCUSDT"` for a peg check) or
 * leave it out of the picker.
 *
 * @see https://www.mexc.com/api-docs/spot-v3/market-data-endpoints/symbol-order-book-ticker
 */
export class MexcProvider implements RateProvider {
  readonly name = "mexc";
  readonly asset: UsdStablecoin;
  private readonly symbol: string;
  private readonly invert: boolean;
  private readonly price: MexcPriceField;
  private readonly twapWindowMs: number;
  private readonly klineInterval: string;
  private readonly twapFallback: MexcTwapFallback;
  private readonly maxStalenessMs: number | false;
  private readonly baseUrl: string;

  constructor(options: MexcProviderOptions = {}) {
    this.asset = options.asset ?? "USDT";
    const quote = (options.quote ?? "NGN").toUpperCase();
    this.symbol = (options.symbol ?? `${this.asset}${quote}`).toUpperCase();
    this.invert = options.invert ?? !this.symbol.startsWith(this.asset.toUpperCase());
    this.price = options.price ?? "twap";
    this.twapWindowMs = options.twapWindowMs ?? 3_600_000;
    this.klineInterval = options.klineInterval ?? "1m";
    this.twapFallback = options.twapFallback ?? "mid";
    this.maxStalenessMs = options.maxStalenessMs ?? 21_600_000;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

    if (!Number.isFinite(this.twapWindowMs) || this.twapWindowMs <= 0) {
      throw new Error(
        `twapWindowMs must be a positive number of milliseconds, got ${options.twapWindowMs}`,
      );
    }
  }

  async getPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    if (this.price !== "twap") return this.fetchSpot(ctx, this.price);

    const now = Date.now();
    const { points, raw } = await this.fetchKline(ctx, now);
    const newest = newestPoint(points);
    if (newest && this.maxStalenessMs !== false && now - newest.at > this.maxStalenessMs) {
      const hours = ((now - newest.at) / 3_600_000).toFixed(1);
      throw new Error(
        `MEXC symbol "${this.symbol}" is stale: newest candle is ${hours}h old ` +
          `(max ${this.maxStalenessMs}ms) — the market may be dormant`,
      );
    }

    const twap = timeWeightedAverage(withinWindow(points, now - this.twapWindowMs), now);
    if (twap !== null) return { price: twap, raw };

    if (this.twapFallback === false) {
      throw new Error(
        `no MEXC candles for "${this.symbol}" in the last ${this.twapWindowMs}ms`,
      );
    }
    const spot = await this.fetchSpot(ctx, this.twapFallback);
    return {
      price: spot.price,
      raw: { twapFellBackTo: this.twapFallback, klines: raw, spot: spot.raw },
    };
  }

  /** One spot price, from whichever documented ticker endpoint the field needs. */
  private async fetchSpot(
    ctx: ProviderContext,
    field: Exclude<MexcPriceField, "twap">,
  ): Promise<ProviderQuote> {
    if (field === "last") {
      const body = await this.request<MexcPriceTicker | MexcPriceTicker[]>(
        `/api/v3/ticker/price?symbol=${encodeURIComponent(this.symbol)}`,
        ctx,
      );
      const ticker = Array.isArray(body)
        ? body.find((t) => t?.symbol?.toUpperCase() === this.symbol)
        : body;
      if (!ticker?.symbol) {
        throw new Error(`MEXC returned no price ticker for "${this.symbol}"`);
      }
      const price = toPrice(ticker.price);
      return { price: this.invert ? 1 / price : price, raw: ticker };
    }

    const book = await this.fetchBookTicker(ctx);
    return { price: this.pickBookPrice(book, field), raw: book };
  }

  private async fetchKline(
    ctx: ProviderContext,
    nowMs: number,
  ): Promise<{ points: PricePoint[]; raw: MexcCandle[] }> {
    const limit = Math.min(
      Math.max(Math.ceil(this.twapWindowMs / this.intervalMs()) + 1, 2),
      MAX_CANDLES,
    );
    const body = await this.request<MexcCandle[]>(
      `/api/v3/klines?symbol=${encodeURIComponent(this.symbol)}` +
        `&interval=${encodeURIComponent(this.klineInterval)}&limit=${limit}`,
      ctx,
    );
    if (!Array.isArray(body)) {
      throw new Error(`unexpected MEXC kline response for "${this.symbol}"`);
    }

    const points = body
      .filter((c) => Array.isArray(c) && c.length >= 5 && Number.isFinite(Number(c[0])))
      .map((c) => {
        // Close is the last price that cleared in the candle; stamped at the
        // candle's open, matching how the other kline-based providers weight.
        const close = toPrice(c[4]);
        return { price: this.invert ? 1 / close : close, at: Number(c[0]) };
      })
      .filter((p) => p.at <= nowMs);
    return { points, raw: body };
  }

  private async fetchBookTicker(ctx: ProviderContext): Promise<MexcBookTicker> {
    const body = await this.request<MexcBookTicker | MexcBookTicker[]>(
      `/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(this.symbol)}`,
      ctx,
    );
    // The endpoint returns an array when no symbol is given; tolerate it in
    // case a caller points `symbol` at something that behaves that way.
    const ticker = Array.isArray(body)
      ? body.find((t) => t?.symbol?.toUpperCase() === this.symbol)
      : body;
    if (!ticker?.symbol) {
      throw new Error(`MEXC returned no book ticker for "${this.symbol}"`);
    }
    return ticker;
  }

  /** GETs JSON, turning MEXC's `{msg, code}` error body into the thrown message. */
  private async request<T>(path: string, ctx: ProviderContext): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetchOrDescribe(url, { method: "GET", headers: { accept: "application/json" } }, ctx);
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const err = body as MexcError | undefined;
      const detail = err?.msg ? `${err.code ?? "error"}: ${err.msg}` : `HTTP ${res.status} ${res.statusText}`;
      throw new Error(`MEXC ${detail} for "${this.symbol}"`);
    }
    if (body === undefined) {
      throw new Error(`MEXC returned a non-JSON response for "${this.symbol}"`);
    }
    // A 200 can still carry an error body on some MEXC routes.
    const maybeErr = body as MexcError;
    if (!Array.isArray(body) && maybeErr?.code !== undefined && maybeErr.code !== 0 && maybeErr.msg) {
      throw new Error(`MEXC ${maybeErr.code}: ${maybeErr.msg} for "${this.symbol}"`);
    }
    return body as T;
  }

  private pickBookPrice(ticker: MexcBookTicker, field: "mid" | "bid" | "ask"): number {
    const raw = (value: number) => (this.invert ? 1 / value : value);
    switch (field) {
      case "bid":
        return raw(toPrice(ticker.bidPrice));
      case "ask":
        return raw(toPrice(ticker.askPrice));
      default: {
        // Invert each side before averaging: the mid of inverted prices is not
        // the inverse of the mid.
        const bid = raw(toPrice(ticker.bidPrice));
        const ask = raw(toPrice(ticker.askPrice));
        return (bid + ask) / 2;
      }
    }
  }

  /** Milliseconds per candle, parsed from MEXC's interval notation. */
  private intervalMs(): number {
    const match = /^(\d+)([mhdwM])$/.exec(this.klineInterval);
    if (!match) return 60_000;
    const size = Number(match[1]);
    const unit = match[2]!;
    const perUnit: Record<string, number> = {
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
      M: 2_592_000_000,
    };
    return size * (perUnit[unit] ?? 60_000);
  }

  /** @deprecated Use {@link getPriceInNgn}; this alias quotes whatever `asset` is configured. */
  getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    return this.getPriceInNgn(ctx);
  }
}
