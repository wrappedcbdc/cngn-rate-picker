
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    /** The original thrown value, when there was one. */
    readonly cause?: unknown,
  ) {
    super(`[${provider}] ${message}`);
    this.name = "ProviderError";
  }
}

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

export class ThresholdNotMetError extends Error {
  constructor(
    readonly threshold: number,
    readonly succeeded: number,
    readonly errors: ProviderError[],
  ) {
    super(
      `Only ${succeeded}/${threshold} required provider(s) succeeded: ${errors
        .map((e) => e.message)
        .join("; ")}`,
    );
    this.name = "ThresholdNotMetError";
  }
}
