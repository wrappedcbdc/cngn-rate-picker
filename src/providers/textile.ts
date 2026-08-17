import type { ProviderContext, ProviderQuote, RateProvider, UsdStablecoin } from "../types.js";
import { httpJson, toPrice } from "../http.js";
import { timeWeightedAverage } from "../twap.js";

interface TextileTicker {
  ticker_id: string;
  base_currency: string;
  target_currency: string;
  last_price: string | number;
  bid: string | number;
  ask: string | number;
  high?: string | number;
  low?: string | number;
  base_volume?: string | number;
  target_volume?: string | number;
}

interface TextileTrade {
  trade_id: string;
  price: string | number;
  base_volume?: string | number;
  target_volume?: string | number;
  /** Unix seconds. */
  trade_timestamp: number;
  type?: "buy" | "sell";
}

interface TextileTradesResponse {
  buy?: TextileTrade[];
  sell?: TextileTrade[];
}

const DEFAULT_BASE_URL = "https://api.textilecredit.com";
/** The feed caps `limit` at 1000 trades per request. */
const MAX_TRADE_LIMIT = 1000;

/**
 * Which price to quote. `"twap"` is the time-weighted average of cleared
 * trades; the rest read the live order book from `/tickers`.
 */
export type TextilePriceField = "twap" | "mid" | "last" | "bid" | "ask";

/** Order-book field used when the TWAP window holds no trades. */
export type TextileTwapFallback = "mid" | "last" | "bid" | "ask" | false;

export interface TextileProviderOptions {
  /** USD stablecoin side of the corridor (default "USDT"). */
  asset?: UsdStablecoin;
  /**
   * Explicit ticker id. Defaults to `<asset>_NGN` (e.g. "USDT_NGN") — Textile
   * publishes cNGN as plain "NGN" since it is pegged 1:1 to the naira.
   */
  tickerId?: string;
  /**
   * Which price to take (default "twap"): the time-weighted average of trades
   * cleared over {@link twapWindowMs}, the bid/ask mid, the best available
   * `last_price`, or one side of the book. The TWAP is built from real
   * executions rather than quotes, so a single large print or a momentarily
   * skewed book can't move it much.
   */
  price?: TextilePriceField;
  /** How far back the TWAP looks, in milliseconds (default 1 hour). */
  twapWindowMs?: number;
  /** Trades requested per side, capped by the feed at 1000 (default 200). */
  twapLimit?: number;
  /**
   * Order-book field to fall back on when no trades cleared in the window
   * (default "mid"). `false` throws instead, so the picker fails the provider
   * over to another source rather than mixing a quote into a trade-based rate.
   */
  twapFallback?: TextileTwapFallback;
  baseUrl?: string;
}

/**
 * Stablecoin/NGN rate from the Textile Credit FX feed.
 *
 * Public, unauthenticated, CoinGecko-convention feed: prices are quoted target
 * per base, so `USDT_NGN` is already NGN per USDT and needs no inversion.
 *
 * By default the quote is a TWAP over `GET /historical_trades` — real cleared
 * prices, weighted by how long each one stood as the last trade. Set `price`
 * to read `GET /tickers` (order book) instead.
 *
 * @see https://fx-docs.textilecredit.com/api/rates.html
 */
export class TextileProvider implements RateProvider {
  readonly name = "textile";
  readonly asset: UsdStablecoin;
  private readonly tickerId: string;
  private readonly price: TextilePriceField;
  private readonly twapWindowMs: number;
  private readonly twapLimit: number;
  private readonly twapFallback: TextileTwapFallback;
  private readonly baseUrl: string;

  constructor(options: TextileProviderOptions = {}) {
    this.asset = options.asset ?? "USDT";
    this.tickerId = options.tickerId ?? `${this.asset.toUpperCase()}_NGN`;
    this.price = options.price ?? "twap";
    this.twapWindowMs = options.twapWindowMs ?? 3_600_000;
    this.twapLimit = Math.min(options.twapLimit ?? 200, MAX_TRADE_LIMIT);
    this.twapFallback = options.twapFallback ?? "mid";
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

    if (!Number.isFinite(this.twapWindowMs) || this.twapWindowMs <= 0) {
      throw new Error(`twapWindowMs must be a positive number of milliseconds, got ${options.twapWindowMs}`);
    }
    if (!Number.isInteger(this.twapLimit) || this.twapLimit < 1) {
      throw new Error(`twapLimit must be a positive integer, got ${options.twapLimit}`);
    }
  }

  async getPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    if (this.price !== "twap") {
      const ticker = await this.fetchTicker(ctx);
      return { price: this.pickBookPrice(ticker.ticker, this.price), raw: ticker.raw };
    }

    const now = Date.now();
    const trades = await this.fetchTrades(ctx, now);
    const twap = this.computeTwap(trades.trades, now);
    if (twap !== null) {
      return { price: twap, raw: trades.raw };
    }

    if (this.twapFallback === false) {
      throw new Error(
        `no Textile trades cleared for "${this.tickerId}" in the last ${this.twapWindowMs}ms`,
      );
    }
    const ticker = await this.fetchTicker(ctx);
    return {
      price: this.pickBookPrice(ticker.ticker, this.twapFallback),
      raw: { twapFellBackTo: this.twapFallback, trades: trades.raw, ticker: ticker.raw },
    };
  }

  /** Cleared trades in the window, both sides merged, oldest first. */
  private async fetchTrades(
    ctx: ProviderContext,
    nowMs: number,
  ): Promise<{ trades: TextileTrade[]; raw: TextileTradesResponse }> {
    const startTime = Math.floor((nowMs - this.twapWindowMs) / 1000);
    const body = await httpJson<TextileTradesResponse | TextileTrade[] | { error?: string }>(
      `${this.baseUrl}/historical_trades?ticker_id=${encodeURIComponent(this.tickerId)}` +
        `&limit=${this.twapLimit}&start_time=${startTime}`,
      { ctx },
    );
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error(`unexpected Textile trades response for "${this.tickerId}"`);
    }
    const { buy, sell } = body as TextileTradesResponse;
    if (buy === undefined && sell === undefined) {
      const { error } = body as { error?: string };
      throw new Error(
        `unexpected Textile trades response for "${this.tickerId}"${error ? `: ${error}` : ""}`,
      );
    }

    // Both sides are executions of the same corridor; merge and order oldest
    // first. The feed serves newest first, and duplicate timestamps are normal.
    const trades = [...(buy ?? []), ...(sell ?? [])]
      .filter((t) => t && Number.isFinite(Number(t.trade_timestamp)))
      .sort((a, b) => Number(a.trade_timestamp) - Number(b.trade_timestamp));
    return { trades, raw: body as TextileTradesResponse };
  }

  /** TWAP over cleared trades; null when the window is empty. */
  private computeTwap(trades: TextileTrade[], nowMs: number): number | null {
    return timeWeightedAverage(
      trades.map((t) => ({ price: toPrice(t.price), at: Number(t.trade_timestamp) * 1000 })),
      nowMs,
    );
  }

  private async fetchTicker(
    ctx: ProviderContext,
  ): Promise<{ ticker: TextileTicker; raw: TextileTicker[] }> {
    // Unknown pairs 404, which httpJson surfaces as an error.
    const body = await httpJson<TextileTicker[] | { error?: string }>(
      `${this.baseUrl}/tickers?ticker_id=${encodeURIComponent(this.tickerId)}`,
      { ctx },
    );
    if (!Array.isArray(body)) {
      throw new Error(
        `unexpected Textile response for "${this.tickerId}"${
          body?.error ? `: ${body.error}` : ""
        }`,
      );
    }

    const wanted = this.tickerId.toUpperCase();
    const ticker = body.find((t) => t?.ticker_id?.toUpperCase() === wanted) ?? body[0];
    if (!ticker) throw new Error(`Textile returned no ticker for "${this.tickerId}"`);
    return { ticker, raw: body };
  }

  private pickBookPrice(ticker: TextileTicker, field: Exclude<TextilePriceField, "twap">): number {
    switch (field) {
      case "bid":
        return toPrice(ticker.bid);
      case "ask":
        return toPrice(ticker.ask);
      case "last":
        return toPrice(ticker.last_price);
      default:
        try {
          return (toPrice(ticker.bid) + toPrice(ticker.ask)) / 2;
        } catch {
          return toPrice(ticker.last_price);
        }
    }
  }

  /** @deprecated Use {@link getPriceInNgn}; this alias quotes whatever `asset` is configured. */
  getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    return this.getPriceInNgn(ctx);
  }
}
