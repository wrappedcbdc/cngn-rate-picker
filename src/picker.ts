import type { CurrencyCode, Rate, RateProvider } from "./types.js";
import { AllProvidersFailedError, ProviderError } from "./errors.js";

export interface CircuitBreakerOptions {
  /** Consecutive failures before a provider is temporarily skipped. */
  failureThreshold: number;
  /** How long (ms) to skip a tripped provider before trying it again. */
  cooldownMs: number;
}

export interface RatePickerOptions {
  /** Providers in priority order. Index 0 is tried first. */
  providers: RateProvider[];
  /** Per-provider timeout in ms. Default: 5000. */
  timeoutMs?: number;
  /** Cache the canonical rate for this many ms. 0 disables caching. Default: 0. */
  cacheTtlMs?: number;
  /** Circuit breaker config, or `false` to disable. Default: 3 failures / 30s. */
  circuitBreaker?: CircuitBreakerOptions | false;
  /** Injectable fetch (proxying, mocking, instrumentation). Default: global fetch. */
  fetch?: typeof fetch;
  /** Called once per provider failure (observability). */
  onProviderError?: (error: ProviderError) => void;
  /** Called when a provider successfully supplies a rate. */
  onSuccess?: (rate: Rate) => void;
}

interface Health {
  failures: number;
  openedAt: number | null;
}

interface CanonicalRate {
  price: number; // NGN per 1 USDT
  provider: string;
  timestamp: number;
  raw?: unknown;
}

/**
 * ExchangeRatePicker
 *
 * A facade over an ordered list of providers. On each request it walks the
 * chain (Chain of Responsibility) and returns the first successful quote,
 * transparently failing over when a provider errors, times out, or is held
 * open by the circuit breaker. Results can be cached with a TTL.
 *
 * Providers themselves are interchangeable strategies (Strategy pattern), each
 * adapting a different upstream API (Adapter pattern) to one interface.
 */
export class ExchangeRatePicker {
  private readonly providers: RateProvider[];
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
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
    this.providers = options.providers;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.cacheTtlMs = options.cacheTtlMs ?? 0;
    this.breaker =
      options.circuitBreaker === undefined
        ? { failureThreshold: 3, cooldownMs: 30_000 }
        : options.circuitBreaker;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.onProviderError = options.onProviderError;
    this.onSuccess = options.onSuccess;

    if (!this.fetchImpl) {
      throw new Error("No fetch implementation available; pass `fetch` in options");
    }
  }

  /** 1 USDT expressed in NGN. */
  async getUsdtToNgn(): Promise<Rate> {
    return this.getRate("USDT", "NGN");
  }

  /** 1 NGN expressed in USDT. */
  async getNgnToUsdt(): Promise<Rate> {
    return this.getRate("NGN", "USDT");
  }

  /** Generic accessor for either direction. */
  async getRate(base: CurrencyCode, quote: CurrencyCode): Promise<Rate> {
    if (base === quote) {
      return this.buildRate(base, quote, 1, { price: 1, provider: "identity", timestamp: Date.now() }, false);
    }
    const canonical = await this.resolveCanonical();
    // canonical.price is NGN per USDT.
    const rate = base === "USDT" ? canonical.price : 1 / canonical.price;
    return this.buildRate(base, quote, rate, canonical, this.servedFromCache);
  }

  /** Convert an amount and return both the converted value and the rate used. */
  async convert(
    amount: number,
    base: CurrencyCode,
    quote: CurrencyCode,
  ): Promise<{ amount: number; rate: Rate }> {
    const rate = await this.getRate(base, quote);
    return { amount: amount * rate.rate, rate };
  }

  /** Force the next call to re-fetch instead of using the cache. */
  clearCache(): void {
    this.cache = null;
  }

  // --- internals -------------------------------------------------------------

  private servedFromCache = false;

  private async resolveCanonical(): Promise<CanonicalRate> {
    if (this.cache && this.cacheTtlMs > 0 && Date.now() - this.cache.timestamp < this.cacheTtlMs) {
      this.servedFromCache = true;
      return this.cache;
    }
    this.servedFromCache = false;

    const errors: ProviderError[] = [];
    for (const provider of this.providers) {
      if (this.isOpen(provider.name)) {
        errors.push(new ProviderError(provider.name, "skipped (circuit open)"));
        continue;
      }
      try {
        const quote = await this.callWithTimeout(provider);
        this.recordSuccess(provider.name);
        const canonical: CanonicalRate = {
          price: quote.price,
          provider: provider.name,
          timestamp: Date.now(),
          raw: quote.raw,
        };
        if (this.cacheTtlMs > 0) this.cache = canonical;
        return canonical;
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
    throw new AllProvidersFailedError(errors);
  }

  private async callWithTimeout(provider: RateProvider) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`timeout after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    try {
      return await provider.getUsdtPriceInNgn({ signal: controller.signal, fetch: this.fetchImpl });
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
    };
    if (!cached) this.onSuccess?.(result);
    return result;
  }

  // --- circuit breaker -------------------------------------------------------

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
