import { test } from "node:test";
import assert from "node:assert/strict";
import { ExchangeRatePicker } from "../src/picker.js";
import type { ProviderContext, ProviderQuote, RateProvider } from "../src/types.js";
import { AllProvidersFailedError } from "../src/errors.js";

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

test("returns the rate from the first healthy provider", async () => {
  const picker = new ExchangeRatePicker({ providers: [ok(1500), ok(1400)] });
  const rate = await picker.getUsdtToNgn();
  assert.equal(rate.rate, 1500);
  assert.equal(rate.provider, "ok-1500");
  assert.equal(rate.base, "USDT");
  assert.equal(rate.quote, "NGN");
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
