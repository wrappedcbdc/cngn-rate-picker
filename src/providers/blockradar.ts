import type { ProviderContext, ProviderQuote, RateProvider, UsdStablecoin } from "../types.js";
import { httpJson, toPrice } from "../http.js";

interface BlockradarBenchmarkResponse {
  data?: {
    fromAsset: string;
    toAsset: string;
    bestRate: string | null;
  };
}

interface BlockradarRatesResponse {
  /** `data[outer][inner]` holds the rate for one direction. */
  data?: Record<string, Record<string, string | number> | undefined>;
}

/** One `/assets/rates` lookup and how to read the rate out of it. */
interface BlockradarRoute {
  key: string;
  currency: string;
  assets: string;
  outer: string;
  inner: string;
  /** True when the raw value is cNGN-per-asset and must be inverted. */
  invert: boolean;
}

const DEFAULT_BASE_URL = "https://api.blockradar.co/v1";

/**
 * `"rates"` averages the public `/assets/rates` routes; `"benchmark"` reads the
 * best competing Liquidity Provider rate from `/rates/market-benchmark`.
 */
export type BlockradarPriceMode = "rates" | "benchmark";

export interface BlockradarOptions {
  apiKey: string;
  /** USD stablecoin to price against cNGN (default "USDT"). */
  asset?: UsdStablecoin;
  /**
   * Which rate to quote (default "rates"): the average of the public
   * `/assets/rates` routes for this asset, or the competing-LP figure from
   * `/rates/market-benchmark`.
   */
  price?: BlockradarPriceMode;
  /**
   * Average every stablecoin's routes rather than only the configured asset's
   * (default false). Matches upstream reference implementations that blend
   * USDT and USDC into one cNGN/USD mid; off by default here because this
   * library keeps one picker to one stablecoin.
   */
  allRoutes?: boolean;
  baseUrl?: string;
}

/** Routes for one asset: cNGN→asset reads direct, asset→cNGN needs inverting. */
function routesFor(asset: string): BlockradarRoute[] {
  const upper = asset.toUpperCase();
  return [
    {
      key: `cngn_${asset.toLowerCase()}`,
      currency: "cNGN",
      assets: upper,
      outer: upper,
      inner: "CNGN",
      invert: false,
    },
    {
      key: `${asset.toLowerCase()}_cngn`,
      currency: upper,
      assets: "cNGN",
      outer: "CNGN",
      inner: upper,
      invert: true,
    },
  ];
}

/**
 * cNGN rate from Blockradar.
 *
 * By default this averages the public `/assets/rates` routes for the
 * configured asset, querying both directions in parallel and normalising each
 * to USD per cNGN before taking the mean — so one missing or broken direction
 * degrades the quote instead of failing it. The mean is then inverted to this
 * library's NGN-per-asset contract.
 *
 * `price: "benchmark"` reads `/rates/market-benchmark` instead, which reports
 * the best rate among *competing* Liquidity Providers in your business segment
 * rather than a market price.
 *
 * Neither endpoint exposes history, so this provider quotes a cross-route
 * average rather than a TWAP.
 */
export class BlockradarProvider implements RateProvider {
  readonly name = "blockradar";
  readonly asset: UsdStablecoin;
  private readonly apiKey: string;
  private readonly price: BlockradarPriceMode;
  private readonly allRoutes: boolean;
  private readonly baseUrl: string;

  constructor(opts: BlockradarOptions, baseUrl = DEFAULT_BASE_URL) {
    this.apiKey = opts.apiKey;
    this.asset = opts.asset ?? "USDT";
    this.price = opts.price ?? "rates";
    this.allRoutes = opts.allRoutes ?? false;
    this.baseUrl = opts.baseUrl ?? baseUrl;
    if (!this.apiKey) throw new Error("BlockradarProvider requires an apiKey");
  }

  async getPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    if (this.price === "benchmark") return this.fetchBenchmark(ctx);

    const routes = this.allRoutes
      ? [...routesFor(this.asset), ...routesFor(this.asset === "USDC" ? "USDT" : "USDC")]
      : routesFor(this.asset);

    const settled = await Promise.allSettled(
      routes.map(async (route) => ({ route, usdPerCngn: await this.fetchRoute(ctx, route) })),
    );

    const usable: { key: string; usdPerCngn: number }[] = [];
    const failures: string[] = [];
    settled.forEach((result, i) => {
      const route = routes[i]!;
      if (result.status === "fulfilled") {
        usable.push({ key: route.key, usdPerCngn: result.value.usdPerCngn });
      } else {
        failures.push(`${route.key}: ${(result.reason as Error)?.message ?? "unknown error"}`);
      }
    });

    if (usable.length === 0) {
      throw new Error(
        `no Blockradar rate routes available for ${this.asset}/cNGN (${failures.join("; ")})`,
      );
    }

    // Averaged as USD per cNGN, the basis every route normalises to, then
    // inverted to NGN per asset.
    const mid = usable.reduce((sum, r) => sum + r.usdPerCngn, 0) / usable.length;
    return {
      price: 1 / mid,
      raw: { usdPerCngn: mid, routes: usable, failedRoutes: failures },
    };
  }

  /** One route, normalised to USD per cNGN. */
  private async fetchRoute(ctx: ProviderContext, route: BlockradarRoute): Promise<number> {
    const body = await httpJson<BlockradarRatesResponse>(
      `${this.baseUrl}/assets/rates?currency=${encodeURIComponent(route.currency)}` +
        `&assets=${encodeURIComponent(route.assets)}`,
      { ctx, headers: { "x-api-key": this.apiKey } },
    );
    const raw = body?.data?.[route.outer]?.[route.inner];
    if (raw === undefined || raw === null) {
      throw new Error(`data["${route.outer}"]["${route.inner}"] missing`);
    }
    const value = toPrice(raw);
    return route.invert ? 1 / value : value;
  }

  private async fetchBenchmark(ctx: ProviderContext): Promise<ProviderQuote> {
    const body = await httpJson<BlockradarBenchmarkResponse>(
      `${this.baseUrl}/rates/market-benchmark?fromAsset=${encodeURIComponent(this.asset)}&toAsset=cNGN`,
      { ctx, headers: { "x-api-key": this.apiKey } },
    );
    const rate = body?.data?.bestRate;
    if (rate == null) {
      throw new Error(`no Blockradar market benchmark available for ${this.asset}/cNGN`);
    }
    return { price: toPrice(rate), raw: body };
  }

  /** @deprecated Use {@link getPriceInNgn}; this alias quotes whatever `asset` is configured. */
  getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    return this.getPriceInNgn(ctx);
  }
}
