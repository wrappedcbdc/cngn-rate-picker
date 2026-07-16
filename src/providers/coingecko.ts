import type { ProviderContext, ProviderQuote, RateProvider, UsdStablecoin } from "../types.js";
import { httpJson, toPrice } from "../http.js";

type CoinGeckoSimplePrice = Record<string, { ngn?: number }>;

/** CoinGecko coin ids for the stablecoins we know out of the box. */
const COIN_IDS: Record<string, string> = {
  USDT: "tether",
  USDC: "usd-coin",
};

export interface CoinGeckoProviderOptions {
  /** USD stablecoin to price in NGN (default "USDT"). */
  asset?: UsdStablecoin;
  /**
   * CoinGecko coin id (the `ids` query parameter). Required for assets
   * without a built-in mapping; overrides the mapping when provided.
   */
  coinId?: string;
  baseUrl?: string;
}

export class CoinGeckoProvider implements RateProvider {
  readonly name = "coingecko";
  readonly asset: UsdStablecoin;
  private readonly coinId: string;
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
    this.baseUrl = opts.baseUrl ?? "https://api.coingecko.com/api/v3";
  }

  async getPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
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
