import { test } from "node:test";
import assert from "node:assert/strict";
import { ExchangeRatePicker } from "../src/picker.js";
import type { ProviderContext, ProviderQuote, RateProvider } from "../src/types.js";
import { AllProvidersFailedError, ThresholdNotMetError } from "../src/errors.js";

/** A controllable fake provider for deterministic tests. */
class FakeProvider implements RateProvider {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly behaviour: () => ProviderQuote,
  ) {}
  async getUsdtPriceInNgn(_ctx: ProviderContext): Promise<ProviderQuote> {
    this.calls++;
    return this.behaviour();
  }
}

const ok = (price: number) => new FakeProvider(`ok-${price}`, () => ({ price }));
const fail = (name = "boom") =>
  new FakeProvider(name, () => {
    throw new Error("provider down");
  });

/** A provider that resolves after `delayMs` and tracks whether it was aborted. */
class DelayedProvider implements RateProvider {
  calls = 0;
  aborted = false;
  constructor(
    readonly name: string,
    private readonly delayMs: number,
    private readonly price: number,
  ) {}
  async getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    this.calls++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ price: this.price }), this.delayMs);
      ctx.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        this.aborted = true;
        reject(new Error("aborted"));
      });
    });
  }
}

test("uses the top-priority provider's rate, but still queries every provider", async () => {
  const first = ok(1500);
  const second = ok(1400);
  const picker = new ExchangeRatePicker({ providers: [first, second] });
  const rate = await picker.getUsdtToNgn();
  assert.equal(rate.rate, 1500);
  assert.equal(rate.provider, "ok-1500");
  assert.equal(rate.base, "USDT");
  assert.equal(rate.quote, "NGN");
  assert.equal(first.calls, 1);
  assert.equal(second.calls, 1, "there is no early exit — every provider is queried");
});

test("fails over to the next provider when the first throws", async () => {
  const first = fail("first");
  const second = ok(1420);
  const picker = new ExchangeRatePicker({ providers: [first, second] });
  const rate = await picker.getUsdtToNgn();
  assert.equal(rate.rate, 1420);
  assert.equal(rate.provider, "ok-1420");
  assert.equal(first.calls, 1);
  assert.equal(second.calls, 1);
});

test("throws AllProvidersFailedError when every provider fails", async () => {
  const picker = new ExchangeRatePicker({ providers: [fail("a"), fail("b")] });
  await assert.rejects(() => picker.getUsdtToNgn(), (err) => {
    assert.ok(err instanceof AllProvidersFailedError);
    assert.equal(err.errors.length, 2);
    return true;
  });
});

test("inverts correctly for NGN -> USDT", async () => {
  const picker = new ExchangeRatePicker({ providers: [ok(2000)] });
  const rate = await picker.getNgnToUsdt();
  assert.equal(rate.base, "NGN");
  assert.equal(rate.rate, 1 / 2000);
});

test("convert multiplies by the resolved rate", async () => {
  const picker = new ExchangeRatePicker({ providers: [ok(1500)] });
  const { amount } = await picker.convert(10, "USDT", "NGN");
  assert.equal(amount, 15000);
  const back = await picker.convert(15000, "NGN", "USDT");
  assert.equal(back.amount, 10);
});

test("caches within the TTL and only calls the provider once", async () => {
  const p = ok(1500);
  const picker = new ExchangeRatePicker({ providers: [p], cacheTtlMs: 60_000 });
  const first = await picker.getUsdtToNgn();
  const second = await picker.getUsdtToNgn();
  assert.equal(p.calls, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
});

test("circuit breaker skips a provider after the failure threshold", async () => {
  const flaky = fail("flaky");
  const backup = ok(1400);
  const picker = new ExchangeRatePicker({
    providers: [flaky, backup],
    circuitBreaker: { failureThreshold: 2, cooldownMs: 10_000 },
  });

  await picker.getUsdtToNgn(); // failure 1 on flaky
  await picker.getUsdtToNgn(); // failure 2 -> trips open
  const callsWhenTripped = flaky.calls;
  await picker.getUsdtToNgn(); // flaky should be skipped now
  assert.equal(flaky.calls, callsWhenTripped, "tripped provider must be skipped");
});

test("circuit breaker half-opens after cooldown", async () => {
  const flaky = fail("flaky");
  const backup = ok(1400);
  const picker = new ExchangeRatePicker({
    providers: [flaky, backup],
    circuitBreaker: { failureThreshold: 1, cooldownMs: 5 },
  });
  await picker.getUsdtToNgn(); // trips immediately
  const before = flaky.calls;
  await new Promise((r) => setTimeout(r, 8)); // wait out cooldown
  await picker.getUsdtToNgn(); // should retry flaky (half-open)
  assert.equal(flaky.calls, before + 1);
});

test("per-provider timeout aborts a slow provider and fails over", async () => {
  const slow = new FakeProvider("slow", () => ({ price: 1 }));
  // Override to hang until aborted.
  slow.getUsdtPriceInNgn = (ctx: ProviderContext) =>
    new Promise((_resolve, reject) => {
      ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const picker = new ExchangeRatePicker({ providers: [slow, ok(1400)], timeoutMs: 20 });
  const rate = await picker.getUsdtToNgn();
  assert.equal(rate.rate, 1400);
});

test("onProviderError fires for each failed provider", async () => {
  const seen: string[] = [];
  const picker = new ExchangeRatePicker({
    providers: [fail("x"), ok(1400)],
    onProviderError: (e) => seen.push(e.provider),
  });
  await picker.getUsdtToNgn();
  assert.deepEqual(seen, ["x"]);
});

// --- threshold (quorum averaging) -------------------------------------------

test("threshold: queries every provider, but only folds the first N (by priority) into the rate", async () => {
  const p1 = ok(1000);
  const p2 = ok(1200);
  const p3 = ok(1400);
  const p4 = ok(9999);
  const p5 = ok(9999);
  const picker = new ExchangeRatePicker({
    providers: [p1, p2, p3, p4, p5],
    threshold: 3,
  });

  const rate = await picker.getUsdtToNgn();

  // Every provider is queried, even the ones past the quorum...
  for (const p of [p1, p2, p3, p4, p5]) assert.equal(p.calls, 1);
  assert.equal(rate.sources.length, 5);
  // ...but only the first 3 (by provider priority) feed the rate.
  assert.equal(rate.provider, "ok-1000, ok-1200, ok-1400");
  assert.deepEqual(
    rate.sources.map((s) => s.usedInAverage),
    [true, true, true, false, false],
  );
  // The rate is a time-weighted average of just those 3, not the 9999 outliers.
  assert.ok(rate.rate > 900 && rate.rate < 1500, `expected a TWAP of ~1000-1400, got ${rate.rate}`);
});

test("threshold: failed providers don't count toward the quorum, but later providers are still queried", async () => {
  const bad = fail("bad");
  const p1 = ok(1000);
  const p2 = ok(1200);
  const p3 = ok(1600);
  const picker = new ExchangeRatePicker({
    providers: [bad, p1, p2, p3],
    threshold: 2,
  });

  const rate = await picker.getUsdtToNgn();

  assert.equal(p3.calls, 1, "providers beyond the quorum are still queried");
  assert.equal(rate.sources.length, 3); // "bad" failed, so it isn't a source at all
  assert.equal(rate.provider, "ok-1000, ok-1200");
  assert.deepEqual(
    rate.sources.map((s) => s.usedInAverage),
    [true, true, false],
  );
  // Exactly 2 sources feed the rate, and a TWAP of 2 always equals their simple mean.
  assert.equal(rate.rate, (1000 + 1200) / 2);
});

test("threshold: the averaged rate is a genuine time-weighted average, not a plain mean", async () => {
  // q2 stays the "current" quote for ~100ms before q3 supersedes it, vs. q3's
  // ~50ms and q1's negligible sliver — so q2 should pull the result below
  // the plain mean of 2000.
  const q1 = new DelayedProvider("q1", 0, 1000);
  const q2 = new DelayedProvider("q2", 100, 2000);
  const q3 = new DelayedProvider("q3", 50, 3000);
  const picker = new ExchangeRatePicker({ providers: [q1, q2, q3], threshold: 3 });

  const rate = await picker.getUsdtToNgn();

  const plainMean = (1000 + 2000 + 3000) / 3; // 2000
  const expectedTwap = 1000 * 100 + 2000 * 50 + 3000 * 75; // weights: 100, 50, mean(100,50)=75
  const expected = expectedTwap / (100 + 50 + 75); // ~1888.89
  assert.ok(Math.abs(rate.rate - plainMean) > 50, "should visibly differ from a plain average");
  assert.ok(Math.abs(rate.rate - expected) < 50, `expected TWAP close to ~${expected.toFixed(2)}, got ${rate.rate}`);
});

test("threshold: throws ThresholdNotMetError when not enough providers succeed", async () => {
  const picker = new ExchangeRatePicker({
    providers: [ok(1000), fail("b"), fail("c")],
    threshold: 3,
  });

  await assert.rejects(() => picker.getUsdtToNgn(), (err) => {
    assert.ok(err instanceof ThresholdNotMetError);
    assert.equal(err.threshold, 3);
    assert.equal(err.succeeded, 1);
    return true;
  });
});

test("threshold: throws AllProvidersFailedError when zero providers succeed", async () => {
  const picker = new ExchangeRatePicker({
    providers: [fail("a"), fail("b")],
    threshold: 2,
  });

  await assert.rejects(() => picker.getUsdtToNgn(), (err) => {
    assert.ok(err instanceof AllProvidersFailedError);
    return true;
  });
});

test("threshold: rejects a threshold greater than the number of providers", () => {
  assert.throws(
    () => new ExchangeRatePicker({ providers: [ok(1000), ok(1200)], threshold: 3 }),
    /cannot exceed the number of configured providers/,
  );
});

test("threshold: rejects a non-positive threshold", () => {
  assert.throws(
    () => new ExchangeRatePicker({ providers: [ok(1000)], threshold: 0 }),
    /positive integer/,
  );
});

// --- parallel mode -----------------------------------------------------------

test("parallel: threshold > 1 waits for every provider, folding only the first N (by priority) into the rate", async () => {
  const fast1 = new DelayedProvider("fast1", 5, 1000);
  const fast2 = new DelayedProvider("fast2", 10, 1200);
  const slow = new DelayedProvider("slow", 60, 9999);
  const picker = new ExchangeRatePicker({
    providers: [fast1, fast2, slow],
    threshold: 2,
    parallel: true,
  });

  const started = Date.now();
  const rate = await picker.getUsdtToNgn();
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 55, `expected to wait for the slow provider too (took ${elapsed}ms)`);
  assert.equal(fast1.calls, 1);
  assert.equal(fast2.calls, 1);
  assert.equal(slow.calls, 1);
  assert.equal(slow.aborted, false, "parallel + threshold > 1 must not abort stragglers");
  assert.equal(rate.sources.length, 3);
  assert.equal(rate.provider, "fast1, fast2");
  assert.deepEqual(
    rate.sources.map((s) => s.usedInAverage),
    [true, true, false],
  );
  // Only fast1 + fast2 (priority order) feed the rate -> exact 2-way mean.
  assert.equal(rate.rate, (1000 + 1200) / 2);
});

test("parallel: throws ThresholdNotMetError when not enough providers succeed", async () => {
  const picker = new ExchangeRatePicker({
    providers: [ok(1000), fail("b"), fail("c")],
    threshold: 3,
    parallel: true,
  });

  await assert.rejects(() => picker.getUsdtToNgn(), (err) => {
    assert.ok(err instanceof ThresholdNotMetError);
    assert.equal(err.threshold, 3);
    assert.equal(err.succeeded, 1);
    return true;
  });
});

test("parallel: throws AllProvidersFailedError when zero providers succeed", async () => {
  const picker = new ExchangeRatePicker({
    providers: [fail("a"), fail("b")],
    threshold: 2,
    parallel: true,
  });

  await assert.rejects(() => picker.getUsdtToNgn(), (err) => {
    assert.ok(err instanceof AllProvidersFailedError);
    return true;
  });
});

test("parallel: threshold of 1 still waits for every provider and uses the top-priority one", async () => {
  const slow = new DelayedProvider("slow", 60, 9999);
  const fast = new DelayedProvider("fast", 5, 1500);
  const picker = new ExchangeRatePicker({
    providers: [slow, fast],
    threshold: 1,
    parallel: true,
  });

  const started = Date.now();
  const rate = await picker.getUsdtToNgn();
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 55, `expected to wait for the slower provider too (took ${elapsed}ms)`);
  assert.equal(slow.calls, 1);
  assert.equal(fast.calls, 1);
  assert.equal(slow.aborted, false, "there is no early exit to abort for");
  // "slow" is first in priority order, so it's the one used even though it
  // wasn't the fastest to answer.
  assert.equal(rate.rate, 9999);
  assert.equal(rate.provider, "slow");
  assert.deepEqual(
    rate.sources.map((s) => s.usedInAverage),
    [true, false],
  );
});
