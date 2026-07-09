/**
 * A single provider's failure: network error, bad payload, timeout, or a
 * circuit-breaker skip. Carries the provider name so logs and the
 * `onProviderError` hook can attribute the failure.
 */
export class ProviderError extends Error {
  constructor(
    /** The `RateProvider.name` of the provider that failed. */
    readonly provider: string,
    message: string,
    /** The original thrown value, when there was one. */
    readonly cause?: unknown,
  ) {
    super(`[${provider}] ${message}`);
    this.name = "ProviderError";
  }
}

/**
 * Thrown by the picker when every provider in the chain failed (or was
 * skipped by the circuit breaker). `errors` holds one ProviderError per
 * provider, in the order they were tried.
 */
export class AllProvidersFailedError extends Error {
  constructor(readonly errors: ProviderError[]) {
    super(
      `All ${errors.length} provider(s) failed: ${errors
        .map((e) => e.message)
        .join("; ")}`,
    );
    this.name = "AllProvidersFailedError";
  }
}
