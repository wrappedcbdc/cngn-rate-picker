import { test } from "node:test";
import assert from "node:assert/strict";
import { QuidaxProvider } from "../src/providers/quidax.js";
import { CoinGeckoProvider } from "../src/providers/coingecko.js";
import { BlockradarProvider } from "../src/providers/blockradar.js";
import { ExchangeRateApiProvider } from "../src/providers/exchangeRateApi.js";
import type { ProviderContext } from "../src/types.js";

/** Builds a ProviderContext backed by a fake fetch, so no network is hit. */
function fakeCtx(fetchImpl: typeof fetch): ProviderContext {
  return { signal: new AbortController().signal, fetch: fetchImpl };
}

function jsonFetch(payload: unknown, capture?: (url: string) => void): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    capture?.(String(input));
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
}

// --- Quidax ------------------------------------------------------------------

test("QuidaxProvider defaults to the cngnusdt market and USDT asset", async () => {
  let url = "";
  const payload = { status: "ok", data: { cngnusdt: { ticker: { last: "0.000625", buy: "0.000624", sell: "0.000626", high: 0, low: 0, vol: 0, open: 0 } } } };
  const provider = new QuidaxProvider();
  const quote = await provider.getPriceInNgn(fakeCtx(jsonFetch(payload, (u) => (url = u))));

  assert.equal(provider.asset, "USDT");
  assert.match(url, /markets\/tickers\/cngnusdt$/);
  assert.equal(quote.price, 1 / 0.000625); // 1600 NGN per USDT
});

test("QuidaxProvider asset option switches to the matching cNGN market", async () => {
  let url = "";
  const payload = { status: "ok", data: { cngnusdc: { ticker: { last: "0.000625", buy: 0, sell: 0, high: 0, low: 0, vol: 0, open: 0 } } } };
  const provider = new QuidaxProvider({ asset: "USDC" });
  await provider.getPriceInNgn(fakeCtx(jsonFetch(payload, (u) => (url = u))));

  assert.equal(provider.asset, "USDC");
  assert.match(url, /markets\/tickers\/cngnusdc$/);
});

test("QuidaxProvider accepts an explicit market override", async () => {
  let url = "";
  const payload = { status: "ok", data: { custompair: { ticker: { last: "0.001", buy: 0, sell: 0, high: 0, low: 0, vol: 0, open: 0 } } } };
  const provider = new QuidaxProvider({ asset: "PYUSD", market: "custompair" });
  await provider.getPriceInNgn(fakeCtx(jsonFetch(payload, (u) => (url = u))));
  assert.match(url, /markets\/tickers\/custompair$/);
});

test("QuidaxProvider still accepts a bare baseUrl string (legacy signature)", async () => {
  let url = "";
  const payload = { status: "ok", data: { cngnusdt: { ticker: { last: "0.000625", buy: 0, sell: 0, high: 0, low: 0, vol: 0, open: 0 } } } };
  const provider = new QuidaxProvider("https://mock.example/api/v1");
  await provider.getPriceInNgn(fakeCtx(jsonFetch(payload, (u) => (url = u))));
  assert.match(url, /^https:\/\/mock\.example\/api\/v1\//);
});

// --- CoinGecko ---------------------------------------------------------------

test("CoinGeckoProvider maps USDC to the usd-coin id", async () => {
  let url = "";
  const provider = new CoinGeckoProvider({ asset: "USDC" });
  const quote = await provider.getPriceInNgn(
    fakeCtx(jsonFetch({ "usd-coin": { ngn: 1598.2 } }, (u) => (url = u))),
  );
  assert.match(url, /ids=usd-coin&vs_currencies=ngn/);
  assert.equal(quote.price, 1598.2);
});

test("CoinGeckoProvider still defaults to tether (USDT)", async () => {
  let url = "";
  const provider = new CoinGeckoProvider();
  const quote = await provider.getPriceInNgn(
    fakeCtx(jsonFetch({ tether: { ngn: 1601 } }, (u) => (url = u))),
  );
  assert.match(url, /ids=tether&vs_currencies=ngn/);
  assert.equal(quote.price, 1601);
});

test("CoinGeckoProvider requires an explicit coinId for unknown assets", () => {
  assert.throws(() => new CoinGeckoProvider({ asset: "PYUSD" }), /pass \{ coinId \}/);
});

test("CoinGeckoProvider uses a provided coinId for a new stablecoin", async () => {
  let url = "";
  const provider = new CoinGeckoProvider({ asset: "PYUSD", coinId: "paypal-usd" });
  const quote = await provider.getPriceInNgn(
    fakeCtx(jsonFetch({ "paypal-usd": { ngn: 1590 } }, (u) => (url = u))),
  );
  assert.match(url, /ids=paypal-usd&vs_currencies=ngn/);
  assert.equal(quote.price, 1590);
});

// --- Blockradar --------------------------------------------------------------

test("BlockradarProvider benchmarks the configured asset against cNGN", async () => {
  let url = "";
  const payload = { data: { fromAsset: "USDC", toAsset: "cNGN", bestRate: "1602.75" } };
  const provider = new BlockradarProvider({ apiKey: "k", asset: "USDC" });
  const quote = await provider.getPriceInNgn(fakeCtx(jsonFetch(payload, (u) => (url = u))));
  assert.match(url, /fromAsset=USDC&toAsset=cNGN/);
  assert.equal(provider.asset, "USDC");
  assert.equal(quote.price, 1602.75);
});

// --- ExchangeRate-API --------------------------------------------------------

test("ExchangeRateApiProvider declares itself a fiat-USD proxy", async () => {
  const provider = new ExchangeRateApiProvider();
  assert.equal(provider.asset, "USD");
  const quote = await provider.getPriceInNgn(
    fakeCtx(jsonFetch({ result: "success", rates: { NGN: 1547.1 } })),
  );
  assert.equal(quote.price, 1547.1);
});
