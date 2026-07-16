import type { ProviderContext, ProviderQuote, RateProvider, UsdStablecoin } from "../types.js";
import { httpJson, toPrice } from "../http.js";

interface BlockradarBenchmarkResponse {
  data?: {
    fromAsset: string;
    toAsset: string;
    bestRate: string | null;
  };
}

export interface BlockradarOptions {
  apiKey: string;
  /** USD stablecoin to benchmark against cNGN (default "USDT"). */
  asset?: UsdStablecoin;
}

export class BlockradarProvider implements RateProvider {
  readonly name = "blockradar";
  readonly asset: UsdStablecoin;
  private readonly apiKey: string;

  constructor(
    opts: BlockradarOptions,
    private readonly baseUrl = "https://api.blockradar.co/v1",
  ) {
    this.apiKey = opts.apiKey;
    this.asset = opts.asset ?? "USDT";
  }

  async getPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
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
