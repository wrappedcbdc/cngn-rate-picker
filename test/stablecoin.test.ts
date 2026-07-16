import { test } from "node:test";
import assert from "node:assert/strict";
import { ExchangeRatePicker } from "../src/picker.js";
import type {
  LegacyRateProvider,
  ProviderAsset,
  ProviderContext,
  ProviderQuote,
  RateProvider,
} from "../src/types.js";

/** A modern provider quoting a configurable asset. */
class FakeAssetProvider implements RateProvider {
  calls = 0;
  constructor(
    readonly name: string,
    readonly asset: ProviderAsset,
    private readonly price: number,
  ) {}
  async getPriceInNgn(_ctx: ProviderContext): Promise<ProviderQuote> {
    this.calls++;
    return { price: this.price };
  }
}

/** A pre-0.2 provider: only getUsdtPriceInNgn, no asset field. */
class FakeLegacyProvider implements LegacyRateProvider {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly price: number,
  ) {}
  async getUsdtPriceInNgn(_ctx: ProviderContext): Promise<ProviderQuote> {
    this.calls++;
    return { price: this.price };
  }
}

test("a USDC picker labels rates with USDC and uses the provider's quote", async () => {
  const provider = new FakeAssetProvider("usdc-market", "USDC", 1600);
  const picker = new ExchangeRatePicker({ asset: "USDC", providers: [provider] });

  const rate = await picker.getStablecoinToNgn();
  assert.equal(rate.base, "USDC");
  assert.equal(rate.quote, "NGN");
  assert.equal(rate.rate, 1600);

  const inverse = await picker.getNgnToStablecoin();
  assert.equal(inverse.base, "NGN");
  assert.equal(inverse.quote, "USDC");
  assert.equal(inverse.rate, 1 / 1600);
});

test("getStablecoinToNgn on a default picker quotes USDT", async () => {
  const provider = new FakeAssetProvider("usdt-market", "USDT", 1500);
  const picker = new ExchangeRatePicker({ providers: [provider] });
  const rate = await picker.getStablecoinToNgn();
  assert.equal(picker.asset, "USDT");
  assert.equal(rate.base, "USDT");
  assert.equal(rate.rate, 1500);
});

test("getUsdtToNgn throws on a picker configured for a different asset", async () => {
  const picker = new ExchangeRatePicker({
    asset: "USDC",
    providers: [new FakeAssetProvider("usdc-market", "USDC", 1600)],
  });
  await assert.rejects(() => picker.getUsdtToNgn(), /unsupported currency "USDT"/);
  await assert.rejects(() => picker.getNgnToUsdt(), /unsupported currency "USDT"/);
});

test("getRate rejects currencies the picker isn't configured for", async () => {
  const picker = new ExchangeRatePicker({
    providers: [new FakeAssetProvider("usdt-market", "USDT", 1500)],
  });
  await assert.rejects(() => picker.getRate("USDC", "NGN"), /unsupported currency "USDC"/);
  await assert.rejects(() => picker.convert(10, "NGN", "USDC"), /unsupported currency "USDC"/);
});

test("construction throws when a provider's asset doesn't match the picker's", () => {
  assert.throws(
    () =>
      new ExchangeRatePicker({
        asset: "USDT",
        providers: [new FakeAssetProvider("usdc-market", "USDC", 1600)],
      }),
    /quotes USDC but this picker is configured for USDT/,
  );
});

test("a fiat-USD proxy provider is accepted by a picker for any stablecoin", async () => {
  const proxy = new FakeAssetProvider("usd-proxy", "USD", 1550);
  const picker = new ExchangeRatePicker({ asset: "USDC", providers: [proxy] });
  const rate = await picker.getStablecoinToNgn();
  assert.equal(rate.base, "USDC");
  assert.equal(rate.rate, 1550);
});

test("legacy providers (getUsdtPriceInNgn only) still work on a default picker", async () => {
  const legacy = new FakeLegacyProvider("old-school", 1480);
  const picker = new ExchangeRatePicker({ providers: [legacy] });
  const rate = await picker.getUsdtToNgn();
  assert.equal(rate.rate, 1480);
  assert.equal(legacy.calls, 1);
});

test("legacy providers are treated as USDT and rejected by a USDC picker", () => {
  assert.throws(
    () =>
      new ExchangeRatePicker({
        asset: "USDC",
        providers: [new FakeLegacyProvider("old-school", 1480)],
      }),
    /quotes USDT but this picker is configured for USDC/,
  );
});

test("a future stablecoin symbol works end to end without library changes", async () => {
  const provider = new FakeAssetProvider("pyusd-market", "PYUSD", 1520);
  const picker = new ExchangeRatePicker({ asset: "PYUSD", providers: [provider] });
  const rate = await picker.getRate("PYUSD", "NGN");
  assert.equal(rate.base, "PYUSD");
  assert.equal(rate.rate, 1520);
});

test("USDC quotes mix with a USD proxy in one TWAP, in priority order", async () => {
  const market = new FakeAssetProvider("usdc-market", "USDC", 1600);
  const proxy = new FakeAssetProvider("usd-proxy", "USD", 1500);
  const picker = new ExchangeRatePicker({
    asset: "USDC",
    providers: [market, proxy],
    threshold: 2,
  });
  const rate = await picker.getStablecoinToNgn();
  assert.equal(rate.provider, "usdc-market, usd-proxy");
  // A TWAP of exactly 2 sources equals their simple mean.
  assert.equal(rate.rate, (1600 + 1500) / 2);
});

test("construction rejects a nonsensical asset", () => {
  assert.throws(
    () =>
      new ExchangeRatePicker({
        asset: "NGN",
        providers: [new FakeAssetProvider("x", "USD", 1500)],
      }),
    /asset must be a USD-backed stablecoin/,
  );
});
