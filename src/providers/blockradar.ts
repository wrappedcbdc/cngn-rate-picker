import type { ProviderContext, ProviderQuote, RateProvider } from "../types.js";
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
}

export class BlockradarProvider implements RateProvider {
  readonly name = "blockradar";
  private readonly apiKey: string;

  constructor(
    opts: BlockradarOptions,
    private readonly baseUrl = "https://api.blockradar.co/v1",
  ) {
    this.apiKey = opts.apiKey;
  }

  async getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    const body = await httpJson<BlockradarBenchmarkResponse>(
      `${this.baseUrl}/rates/market-benchmark?fromAsset=USDT&toAsset=cNGN`,
      { ctx, headers: { "x-api-key": this.apiKey } },
    );
    const rate = body?.data?.bestRate;
    if (rate == null) throw new Error("no Blockradar market benchmark available for USDT/cNGN");
    return { price: toPrice(rate), raw: body };
  }
}
