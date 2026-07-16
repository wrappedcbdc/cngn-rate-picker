import type {
  AnyRateProvider,
  CurrencyCode,
  LegacyRateProvider,
  ProviderAsset,
  ProviderContext,
  ProviderQuote,
  Rate,
  RateProvider,
  RateSource,
  UsdStablecoin,
} from "./types.js";
import { AllProvidersFailedError, ProviderError, ThresholdNotMetError } from "./errors.js";

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
}

export interface RatePickerOptions {
  providers: AnyRateProvider[];
  /**
   * The USD-backed stablecoin this picker trades against NGN (default
   * "USDT"). Every provider must quote this asset (or fiat "USD", which is a
   * valid proxy for any USD stablecoin) — a mismatch throws at construction.
   */
  asset?: UsdStablecoin;
  timeoutMs?: number;
  cacheTtlMs?: number;
  threshold?: number;
  parallel?: boolean;
  circuitBreaker?: CircuitBreakerOptions | false;
  fetch?: typeof fetch;
  onProviderError?: (error: ProviderError) => void;
  onSuccess?: (rate: Rate) => void;
}

interface Health {
  failures: number;
  openedAt: number | null;
}

interface CanonicalRate {
  price: number; // NGN per 1 unit of the configured asset (TWAP across the used sources when threshold > 1)
  provider: string;
  timestamp: number;
  raw?: unknown;
  sources: RateSource[];
}

type RawSource = Omit<RateSource, "usedInAverage">;

/** A provider reduced to one shape, whichever contract it implements. */
interface NormalizedProvider {
  readonly name: string;
  readonly asset: ProviderAsset;
  call(ctx: ProviderContext): Promise<ProviderQuote>;
}

function normalizeProvider(provider: AnyRateProvider): NormalizedProvider {
  const { name } = provider;
  const asset = (provider as Partial<RateProvider>).asset ?? "USDT";
  const modern = provider as Partial<RateProvider>;
  if (typeof modern.getPriceInNgn === "function") {
    return { name, asset, call: (ctx) => modern.getPriceInNgn!(ctx) };
  }
  const legacy = provider as Partial<LegacyRateProvider>;
  if (typeof legacy.getUsdtPriceInNgn === "function") {
    return { name, asset, call: (ctx) => legacy.getUsdtPriceInNgn!(ctx) };
  }
  throw new Error(
    `provider "${name}" implements neither getPriceInNgn nor getUsdtPriceInNgn`,
  );
}

export class ExchangeRatePicker {
  /** The stablecoin this picker trades against NGN. */
  readonly asset: UsdStablecoin;

  private readonly providers: NormalizedProvider[];
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly threshold: number;
  private readonly parallel: boolean;
  private readonly breaker: CircuitBreakerOptions | false;
  private readonly fetchImpl: typeof fetch;
  private readonly onProviderError?: (error: ProviderError) => void;
  private readonly onSuccess?: (rate: Rate) => void;

  private readonly health = new Map<string, Health>();
  private cache: CanonicalRate | null = null;

  constructor(options: RatePickerOptions) {
    if (!options.providers?.length) {
      throw new Error("ExchangeRatePicker requires at least one provider");
    }
    this.asset = options.asset ?? "USDT";
    if (!this.asset || this.asset === "NGN") {
      throw new Error(`asset must be a USD-backed stablecoin symbol, got ${JSON.stringify(this.asset)}`);
    }
    this.providers = options.providers.map(normalizeProvider);
    for (const provider of this.providers) {
      if (provider.asset !== "USD" && provider.asset !== this.asset) {
        throw new Error(
          `provider "${provider.name}" quotes ${provider.asset} but this picker is configured for ${this.asset}; ` +
            `use a matching provider or set the picker's \`asset\` option`,
        );
      }
    }
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.cacheTtlMs = options.cacheTtlMs ?? 0;
    this.threshold = options.threshold ?? 1;
    this.parallel = options.parallel ?? false;
    this.breaker =
      options.circuitBreaker === undefined
        ? { failureThreshold: 3, cooldownMs: 30_000 }
        : options.circuitBreaker;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.onProviderError = options.onProviderError;
    this.onSuccess = options.onSuccess;

    if (!Number.isInteger(this.threshold) || this.threshold < 1) {
      throw new Error("threshold must be a positive integer");
    }
    if (this.threshold > this.providers.length) {
      throw new Error(
        `threshold (${this.threshold}) cannot exceed the number of configured providers (${this.providers.length})`,
      );
    }
    if (!this.fetchImpl) {
      throw new Error("No fetch implementation available; pass `fetch` in options");
    }
  }

  /** NGN per 1 unit of the configured stablecoin. */
  async getStablecoinToNgn(): Promise<Rate> {
    return this.getRate(this.asset, "NGN");
  }

  /** Units of the configured stablecoin per 1 NGN. */
  async getNgnToStablecoin(): Promise<Rate> {
    return this.getRate("NGN", this.asset);
  }

  /** USDT-specific sugar: throws unless the picker's asset is "USDT". */
  async getUsdtToNgn(): Promise<Rate> {
    return this.getRate("USDT", "NGN");
  }

  /** USDT-specific sugar: throws unless the picker's asset is "USDT". */
  async getNgnToUsdt(): Promise<Rate> {
    return this.getRate("NGN", "USDT");
  }

  async getRate(base: CurrencyCode, quote: CurrencyCode): Promise<Rate> {
    for (const code of [base, quote]) {
      if (code !== "NGN" && code !== this.asset) {
        throw new Error(
          `unsupported currency "${code}": this picker trades ${this.asset} <-> NGN`,
        );
      }
    }
    if (base === quote) {
      const identity: CanonicalRate = { price: 1, provider: "identity", timestamp: Date.now(), sources: [] };
      return this.buildRate(base, quote, 1, identity, false);
    }
    const canonical = await this.resolveCanonical();
    // canonical.price is NGN per 1 unit of the configured asset.
    const rate = base === this.asset ? canonical.price : 1 / canonical.price;
    return this.buildRate(base, quote, rate, canonical, this.servedFromCache);
  }

  async convert(
    amount: number,
    base: CurrencyCode,
    quote: CurrencyCode,
  ): Promise<{ amount: number; rate: Rate }> {
    const rate = await this.getRate(base, quote);
    return { amount: amount * rate.rate, rate };
  }

  clearCache(): void {
    this.cache = null;
  }

  private servedFromCache = false;

  private async resolveCanonical(): Promise<CanonicalRate> {
    if (this.cache && this.cacheTtlMs > 0 && Date.now() - this.cache.timestamp < this.cacheTtlMs) {
      this.servedFromCache = true;
      return this.cache;
    }
    this.servedFromCache = false;

    const canonical = this.parallel ? await this.resolveParallel() : await this.resolveSequential();
    if (this.cacheTtlMs > 0) this.cache = canonical;
    return canonical;
  }

  private async resolveSequential(): Promise<CanonicalRate> {
    const errors: ProviderError[] = [];
    const successes: RawSource[] = [];

    for (const provider of this.providers) {
      if (this.isOpen(provider.name)) {
        errors.push(new ProviderError(provider.name, "skipped (circuit open)"));
        continue;
      }
      try {
        const quote = await this.callWithTimeout(provider);
        this.recordSuccess(provider.name);
        successes.push({ provider: provider.name, price: quote.price, raw: quote.raw, fetchedAt: Date.now() });
      } catch (err) {
        const pErr =
          err instanceof ProviderError
            ? err
            : new ProviderError(provider.name, (err as Error)?.message ?? "unknown error", err);
        this.recordFailure(provider.name);
        this.onProviderError?.(pErr);
        errors.push(pErr);
      }
    }

    return this.settle(successes, errors);
  }

  private async resolveParallel(): Promise<CanonicalRate> {
    const errors: ProviderError[] = [];
    const candidates = this.providers.filter((provider) => {
      if (this.isOpen(provider.name)) {
        errors.push(new ProviderError(provider.name, "skipped (circuit open)"));
        return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      return this.settle([], errors);
    }

    const results = await Promise.allSettled(
      candidates.map(async (provider) => {
        const quote = await this.callWithTimeout(provider);
        return { quote, fetchedAt: Date.now() };
      }),
    );

    const successes: RawSource[] = [];
    results.forEach((result, i) => {
      const provider = candidates[i];
      if (!provider) return;
      if (result.status === "fulfilled") {
        this.recordSuccess(provider.name);
        successes.push({
          provider: provider.name,
          price: result.value.quote.price,
          raw: result.value.quote.raw,
          fetchedAt: result.value.fetchedAt,
        });
      } else {
        const err = result.reason;
        const pErr =
          err instanceof ProviderError
            ? err
            : new ProviderError(provider.name, (err as Error)?.message ?? "unknown error", err);
        this.recordFailure(provider.name);
        this.onProviderError?.(pErr);
        errors.push(pErr);
      }
    });

    return this.settle(successes, errors);
  }

  private settle(successes: RawSource[], errors: ProviderError[]): CanonicalRate {
    if (successes.length === 0) throw new AllProvidersFailedError(errors);
    if (successes.length < this.threshold) {
      throw new ThresholdNotMetError(this.threshold, successes.length, errors);
    }

    const used = successes.slice(0, this.threshold);
    const usedNames = new Set(used.map((s) => s.provider));
    const sources: RateSource[] = successes.map((s) => ({ ...s, usedInAverage: usedNames.has(s.provider) }));

    return {
      price: this.computeTwap(used),
      provider: used.map((s) => s.provider).join(", "),
      timestamp: Date.now(),
      raw: used.length === 1 ? used[0]?.raw : undefined,
      sources,
    };
  }

  private computeTwap(sources: RawSource[]): number {
    const first = sources[0];
    if (sources.length === 1 && first) return first.price;

    const sorted = [...sources].sort((a, b) => a.fetchedAt - b.fetchedAt);
    const gaps: number[] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];
      if (current && next) gaps.push(Math.max(next.fetchedAt - current.fetchedAt, 1));
    }
    const meanGap = gaps.reduce((sum, g) => sum + g, 0) / gaps.length;
    const weights = [...gaps, meanGap];

    const weightedSum = sorted.reduce((sum, s, i) => sum + s.price * (weights[i] ?? meanGap), 0);
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    return weightedSum / totalWeight;
  }

  private async callWithTimeout(provider: NormalizedProvider) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`timeout after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    try {
      return await provider.call({ signal: controller.signal, fetch: this.fetchImpl });
    } finally {
      clearTimeout(timer);
    }
  }

  private buildRate(
    base: CurrencyCode,
    quote: CurrencyCode,
    rate: number,
    canonical: CanonicalRate,
    cached: boolean,
  ): Rate {
    const result: Rate = {
      base,
      quote,
      rate,
      provider: canonical.provider,
      timestamp: canonical.timestamp,
      cached,
      raw: canonical.raw,
      sources: canonical.sources,
    };
    if (!cached) this.onSuccess?.(result);
    return result;
  }


  private getHealth(name: string): Health {
    let h = this.health.get(name);
    if (!h) {
      h = { failures: 0, openedAt: null };
      this.health.set(name, h);
    }
    return h;
  }

  private isOpen(name: string): boolean {
    if (!this.breaker) return false;
    const h = this.getHealth(name);
    if (h.openedAt === null) return false;
    if (Date.now() - h.openedAt >= this.breaker.cooldownMs) {
      // Cooldown elapsed: half-open — allow one trial call.
      h.openedAt = null;
      h.failures = 0;
      return false;
    }
    return true;
  }

  private recordSuccess(name: string): void {
    const h = this.getHealth(name);
    h.failures = 0;
    h.openedAt = null;
  }

  private recordFailure(name: string): void {
    if (!this.breaker) return;
    const h = this.getHealth(name);
    h.failures += 1;
    if (h.failures >= this.breaker.failureThreshold) h.openedAt = Date.now();
  }
}
