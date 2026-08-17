import { test } from "node:test";
import assert from "node:assert/strict";
import { QuidaxProvider } from "../src/providers/quidax.js";
import { CoinGeckoProvider } from "../src/providers/coingecko.js";
import { BlockradarProvider } from "../src/providers/blockradar.js";
import { ExchangeRateApiProvider } from "../src/providers/exchangeRateApi.js";
import { BybitP2PProvider } from "../src/providers/bybitP2P.js";
import { TextileProvider } from "../src/providers/textile.js";
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

/** A kline candle `[ms, o, h, l, c, v]`, `minutesAgo` before now. */
function candle(close: number, minutesAgo: number) {
  return [Date.now() - minutesAgo * 60_000, String(close), String(close), String(close), String(close), "1"];
}

function quidaxTicker(market: string, last: string | number, over: Record<string, unknown> = {}) {
  return { status: "ok", data: { [market]: { ticker: { last, buy: 0, sell: 0, high: 0, low: 0, vol: 0, open: 0, ...over } } } };
}

/** Serves Quidax kline and ticker endpoints off the same fake fetch. */
function quidaxFetch(
  candles: unknown,
  ticker: unknown = quidaxTicker("usdtcngn", "1395"),
  capture?: (url: string) => void,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    capture?.(url);
    const payload = url.includes("/k?") ? { status: "success", data: candles } : ticker;
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
}

test("QuidaxProvider defaults to a TWAP of the usdtcngn kline", async () => {
  let url = "";
  // Kept clear of the window edge: a candle stamped exactly at `now - window`
  // is excluded once the provider stamps its own `now` a few ms later.
  // 1600 stood for 30 min, then 1562.5 for 20.
  const candles = [candle(1600, 50), candle(1562.5, 20)];
  const provider = new QuidaxProvider();
  const quote = await provider.getPriceInNgn(fakeCtx(quidaxFetch(candles, undefined, (u) => (url = u))));

  assert.equal(provider.asset, "USDT");
  assert.match(url, /markets\/usdtcngn\/k\?period=1&limit=61$/);
  const expected = (1600 * 30 + 1562.5 * 20) / 50;
  assert.ok(Math.abs(quote.price - expected) < 5, `expected ~${expected}, got ${quote.price}`);
});

test("QuidaxProvider inverts a cngn-prefixed market", async () => {
  const provider = new QuidaxProvider({ market: "cngnusdt" });
  const quote = await provider.getPriceInNgn(fakeCtx(quidaxFetch([candle(0.000625, 30)])));
  assert.equal(quote.price, 1 / 0.000625);
});

test("QuidaxProvider rejects a dormant market instead of quoting a stale price", async () => {
  const sixMonths = 180 * 24 * 60; // minutes
  const provider = new QuidaxProvider();
  await assert.rejects(
    () => provider.getPriceInNgn(fakeCtx(quidaxFetch([candle(0.000625, sixMonths)]))),
    /is stale: newest candle is \d+\.\dh old/,
  );
});

test("QuidaxProvider maxStalenessMs: false accepts an old series", async () => {
  const provider = new QuidaxProvider({ maxStalenessMs: false });
  const quote = await provider.getPriceInNgn(
    fakeCtx(quidaxFetch([candle(1395, 180 * 24 * 60)])),
  );
  assert.equal(quote.price, 1395);
});

test("QuidaxProvider uses the newest close when the window holds no candle", async () => {
  // Fresh enough to pass the staleness guard, but outside the 1h TWAP window.
  const provider = new QuidaxProvider();
  const quote = await provider.getPriceInNgn(fakeCtx(quidaxFetch([candle(1395, 150)])));
  assert.equal(quote.price, 1395);
});

test("QuidaxProvider throws when the kline series is empty", async () => {
  const provider = new QuidaxProvider({ asset: "USDC" });
  await assert.rejects(
    () => provider.getPriceInNgn(fakeCtx(quidaxFetch([]))),
    /no kline candles for market "usdccngn"/,
  );
});

test("QuidaxProvider infers no inversion for an <asset>ngn market", async () => {
  let url = "";
  const provider = new QuidaxProvider({ market: "usdtngn" });
  const quote = await provider.getPriceInNgn(
    fakeCtx(quidaxFetch([candle(1393.21, 30)], undefined, (u) => (url = u))),
  );
  assert.match(url, /markets\/usdtngn\/k\?/);
  assert.equal(quote.price, 1393.21); // already NGN per USDT
});

test("QuidaxProvider invert option overrides the inferred direction", async () => {
  const provider = new QuidaxProvider({ market: "usdtngn", invert: true });
  const quote = await provider.getPriceInNgn(fakeCtx(quidaxFetch([candle(0.000625, 30)])));
  assert.equal(quote.price, 1 / 0.000625);
});

test("QuidaxProvider price: spot reads the ticker, as before", async () => {
  let url = "";
  const provider = new QuidaxProvider({ price: "spot" });
  const quote = await provider.getPriceInNgn(
    fakeCtx(jsonFetch(quidaxTicker("usdtcngn", "1395"), (u) => (url = u))),
  );
  assert.match(url, /markets\/tickers\/usdtcngn$/);
  assert.equal(quote.price, 1395);
});

test("QuidaxProvider spot falls back to the bid/ask mid when last is unusable", async () => {
  const payload = quidaxTicker("usdtcngn", "0", { buy: "1394.8", sell: "1395" });
  const provider = new QuidaxProvider({ price: "spot" });
  const quote = await provider.getPriceInNgn(fakeCtx(jsonFetch(payload)));
  assert.equal(quote.price, (1394.8 + 1395) / 2);
});

test("QuidaxProvider asset option switches to the matching cNGN market", async () => {
  let url = "";
  const provider = new QuidaxProvider({ asset: "USDC" });
  await provider.getPriceInNgn(
    fakeCtx(quidaxFetch([candle(1395, 30)], undefined, (u) => (url = u))),
  );

  assert.equal(provider.asset, "USDC");
  assert.match(url, /markets\/usdccngn\/k\?/);
});

test("QuidaxProvider accepts an explicit market override", async () => {
  let url = "";
  const provider = new QuidaxProvider({ asset: "PYUSD", market: "custompair" });
  await provider.getPriceInNgn(
    fakeCtx(quidaxFetch([candle(0.001, 30)], undefined, (u) => (url = u))),
  );
  assert.match(url, /markets\/custompair\/k\?/);
});

test("QuidaxProvider still accepts a bare baseUrl string (legacy signature)", async () => {
  let url = "";
  const provider = new QuidaxProvider("https://mock.example/api/v1");
  await provider.getPriceInNgn(
    fakeCtx(quidaxFetch([candle(0.000625, 30)], undefined, (u) => (url = u))),
  );
  assert.match(url, /^https:\/\/mock\.example\/api\/v1\//);
});

// --- CoinGecko ---------------------------------------------------------------

/** A market_chart price point, `minutesAgo` before now. */
function chartPoint(price: number, minutesAgo: number): [number, number] {
  return [Date.now() - minutesAgo * 60_000, price];
}

/** Serves market_chart and simple/price off the same fake fetch. */
function geckoFetch(
  prices: unknown,
  spot: unknown = { tether: { ngn: 1601 } },
  capture?: (url: string) => void,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    capture?.(url);
    const payload = url.includes("/market_chart") ? { prices } : spot;
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
}

test("CoinGeckoProvider defaults to a TWAP of the market chart", async () => {
  const urls: string[] = [];
  // Kept clear of the window edge (see the Quidax TWAP test): 1600 for 30 min,
  // then 1500 for 20.
  const prices = [chartPoint(1600, 50), chartPoint(1500, 20)];
  const provider = new CoinGeckoProvider();
  const quote = await provider.getPriceInNgn(fakeCtx(geckoFetch(prices, undefined, (u) => urls.push(u))));

  assert.equal(urls.length, 1); // no spot request when the chart has points
  assert.match(urls[0]!, /coins\/tether\/market_chart\?vs_currency=ngn&days=1$/);
  const expected = (1600 * 30 + 1500 * 20) / 50;
  assert.ok(Math.abs(quote.price - expected) < 5, `expected ~${expected}, got ${quote.price}`);
});

test("CoinGeckoProvider ignores chart points outside the TWAP window", async () => {
  // The 1000 print is 3h old; only the last hour should count.
  const prices = [chartPoint(1000, 180), chartPoint(1600, 45), chartPoint(1600, 15)];
  const provider = new CoinGeckoProvider();
  const quote = await provider.getPriceInNgn(fakeCtx(geckoFetch(prices)));
  assert.equal(quote.price, 1600);
});

test("CoinGeckoProvider maps USDC to the usd-coin id", async () => {
  const urls: string[] = [];
  const provider = new CoinGeckoProvider({ asset: "USDC" });
  const quote = await provider.getPriceInNgn(
    fakeCtx(geckoFetch([chartPoint(1598.2, 30)], undefined, (u) => urls.push(u))),
  );
  assert.match(urls[0]!, /coins\/usd-coin\/market_chart/);
  assert.equal(quote.price, 1598.2);
});

test("CoinGeckoProvider falls back to the spot price on an empty window", async () => {
  const urls: string[] = [];
  const provider = new CoinGeckoProvider();
  const quote = await provider.getPriceInNgn(fakeCtx(geckoFetch([], undefined, (u) => urls.push(u))));

  assert.equal(quote.price, 1601);
  assert.equal(urls.length, 2);
  assert.match(urls[1]!, /simple\/price\?ids=tether&vs_currencies=ngn/);
  assert.equal((quote.raw as { twapFellBackTo?: string }).twapFellBackTo, "spot");
});

test("CoinGeckoProvider twapFallback: false throws on an empty window", async () => {
  const provider = new CoinGeckoProvider({ twapFallback: false });
  await assert.rejects(
    () => provider.getPriceInNgn(fakeCtx(geckoFetch([]))),
    /has no points in the last 3600000ms/,
  );
});

test("CoinGeckoProvider requests whole days to cover a longer window", async () => {
  const urls: string[] = [];
  const provider = new CoinGeckoProvider({ twapWindowMs: 36 * 3_600_000 });
  await provider.getPriceInNgn(
    fakeCtx(geckoFetch([chartPoint(1600, 30)], undefined, (u) => urls.push(u))),
  );
  assert.match(urls[0]!, /days=2$/);
});

test("CoinGeckoProvider price: spot reads simple/price, as before", async () => {
  const urls: string[] = [];
  const provider = new CoinGeckoProvider({ price: "spot" });
  const quote = await provider.getPriceInNgn(
    fakeCtx(jsonFetch({ tether: { ngn: 1601 } }, (u) => urls.push(u))),
  );
  assert.match(urls[0]!, /simple\/price\?ids=tether&vs_currencies=ngn/);
  assert.equal(quote.price, 1601);
});

test("CoinGeckoProvider requires an explicit coinId for unknown assets", () => {
  assert.throws(() => new CoinGeckoProvider({ asset: "PYUSD" }), /pass \{ coinId \}/);
});

test("CoinGeckoProvider uses a provided coinId for a new stablecoin", async () => {
  const urls: string[] = [];
  const provider = new CoinGeckoProvider({ asset: "PYUSD", coinId: "paypal-usd" });
  const quote = await provider.getPriceInNgn(
    fakeCtx(geckoFetch([chartPoint(1590, 20)], undefined, (u) => urls.push(u))),
  );
  assert.match(urls[0]!, /coins\/paypal-usd\/market_chart/);
  assert.equal(quote.price, 1590);
});

// --- Blockradar --------------------------------------------------------------

/** Serves /assets/rates per route, keyed on the currency query param. */
function blockradarFetch(
  rates: Record<string, unknown>,
  capture?: (url: string) => void,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    capture?.(url);
    const currency = new URL(url).searchParams.get("currency") ?? "";
    const payload = rates[currency];
    if (payload === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
}

test("BlockradarProvider averages both rate routes and inverts to NGN", async () => {
  const urls: string[] = [];
  // Both directions agree on 1600 NGN per USDT (0.000625 USD per cNGN).
  const rates = {
    cNGN: { data: { USDT: { CNGN: "0.000625" } } },
    USDT: { data: { CNGN: { USDT: "1600" } } },
  };
  const provider = new BlockradarProvider({ apiKey: "k" });
  const quote = await provider.getPriceInNgn(fakeCtx(blockradarFetch(rates, (u) => urls.push(u))));

  assert.equal(urls.length, 2); // both routes queried in parallel
  assert.ok(urls.some((u) => /currency=cNGN&assets=USDT/.test(u)));
  assert.ok(urls.some((u) => /currency=USDT&assets=cNGN/.test(u)));
  assert.ok(Math.abs(quote.price - 1600) < 0.01, `expected ~1600, got ${quote.price}`);
});

test("BlockradarProvider averages the two routes when they disagree", async () => {
  // 0.000625 → 1600 NGN; 0.000640 → 1562.5 NGN. Averaged as USD per cNGN.
  const rates = {
    cNGN: { data: { USDT: { CNGN: "0.000625" } } },
    USDT: { data: { CNGN: { USDT: "1562.5" } } },
  };
  const quote = await new BlockradarProvider({ apiKey: "k" }).getPriceInNgn(
    fakeCtx(blockradarFetch(rates)),
  );
  const expectedMid = (0.000625 + 1 / 1562.5) / 2;
  assert.ok(Math.abs(quote.price - 1 / expectedMid) < 0.01, `got ${quote.price}`);
});

test("BlockradarProvider degrades to the surviving route", async () => {
  const rates = { cNGN: { data: { USDT: { CNGN: "0.000625" } } } }; // USDT route 404s
  const quote = await new BlockradarProvider({ apiKey: "k" }).getPriceInNgn(
    fakeCtx(blockradarFetch(rates)),
  );
  assert.ok(Math.abs(quote.price - 1600) < 0.01, `expected ~1600, got ${quote.price}`);
  const raw = quote.raw as { routes: unknown[]; failedRoutes: string[] };
  assert.equal(raw.routes.length, 1);
  assert.equal(raw.failedRoutes.length, 1);
});

test("BlockradarProvider throws when every route fails", async () => {
  const provider = new BlockradarProvider({ apiKey: "k" });
  await assert.rejects(
    () => provider.getPriceInNgn(fakeCtx(blockradarFetch({}))),
    /no Blockradar rate routes available for USDT\/cNGN/,
  );
});

test("BlockradarProvider uses the configured asset's routes", async () => {
  const urls: string[] = [];
  const rates = { cNGN: { data: { USDC: { CNGN: "0.000625" } } } };
  const provider = new BlockradarProvider({ apiKey: "k", asset: "USDC" });
  await provider.getPriceInNgn(fakeCtx(blockradarFetch(rates, (u) => urls.push(u))));

  assert.equal(provider.asset, "USDC");
  assert.ok(urls.some((u) => /currency=cNGN&assets=USDC/.test(u)));
  assert.ok(!urls.some((u) => /assets=USDT/.test(u)));
});

test("BlockradarProvider allRoutes also queries the other stablecoin", async () => {
  const urls: string[] = [];
  const rates = {
    cNGN: { data: { USDT: { CNGN: "0.000625" }, USDC: { CNGN: "0.000625" } } },
    USDT: { data: { CNGN: { USDT: "1600" } } },
    USDC: { data: { CNGN: { USDC: "1600" } } },
  };
  const provider = new BlockradarProvider({ apiKey: "k", allRoutes: true });
  await provider.getPriceInNgn(fakeCtx(blockradarFetch(rates, (u) => urls.push(u))));
  assert.equal(urls.length, 4);
});

test("BlockradarProvider sends the api key as x-api-key", async () => {
  let headers: HeadersInit | undefined;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    headers = init?.headers;
    return new Response(JSON.stringify({ data: { USDT: { CNGN: "0.000625" } } }), { status: 200 });
  }) as typeof fetch;
  await new BlockradarProvider({ apiKey: "secret-key" }).getPriceInNgn(fakeCtx(fetchImpl));
  assert.equal((headers as Record<string, string>)["x-api-key"], "secret-key");
});

test("BlockradarProvider price: benchmark reads market-benchmark, as before", async () => {
  let url = "";
  const payload = { data: { fromAsset: "USDC", toAsset: "cNGN", bestRate: "1602.75" } };
  const provider = new BlockradarProvider({ apiKey: "k", asset: "USDC", price: "benchmark" });
  const quote = await provider.getPriceInNgn(fakeCtx(jsonFetch(payload, (u) => (url = u))));
  assert.match(url, /fromAsset=USDC&toAsset=cNGN/);
  assert.equal(provider.asset, "USDC");
  assert.equal(quote.price, 1602.75);
});

test("BlockradarProvider requires an apiKey", () => {
  assert.throws(() => new BlockradarProvider({ apiKey: "" }), /requires an apiKey/);
});

// --- Bybit P2P ---------------------------------------------------------------

/** A reputable online ad; override fields to make it fail a filter. */
function p2pAd(price: number, over: Record<string, unknown> = {}) {
  return {
    price: String(price),
    recentOrderNum: 500,
    recentExecuteRate: 0.98,
    avgReleaseTime: 300,
    isOnline: true,
    ...over,
  };
}

/** Fake Bybit P2P endpoint: serves buy or sell items based on the POSTed side. */
function bybitFetch(
  buyItems: unknown[],
  sellItems: unknown[],
  capture?: (body: Record<string, unknown>) => void,
): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    capture?.(body);
    const items = body.side === "1" ? buyItems : sellItems;
    return new Response(JSON.stringify({ result: { count: items.length, items } }), {
      status: 200,
    });
  }) as typeof fetch;
}

test("BybitP2PProvider returns the mid of modal buy/sell prices after fraud filtering", async () => {
  const buy = [p2pAd(1600), p2pAd(1600), p2pAd(1605), p2pAd(1700, { recentOrderNum: 5 })];
  const sell = [p2pAd(1590), p2pAd(1590), p2pAd(1595), p2pAd(1500, { isOnline: false })];
  const provider = new BybitP2PProvider();
  const quote = await provider.getPriceInNgn(fakeCtx(bybitFetch(buy, sell)));

  assert.equal(provider.asset, "USDT");
  assert.equal(quote.price, (1590 + 1600) / 2);
});

test("BybitP2PProvider rejects prices beyond 2% of the median", async () => {
  const items = [p2pAd(1600), p2pAd(1600), p2pAd(1600), p2pAd(2000)];
  const provider = new BybitP2PProvider();
  const quote = await provider.getPriceInNgn(fakeCtx(bybitFetch(items, items)));
  assert.equal(quote.price, 1600);
});

test("BybitP2PProvider throws when fewer than 3 reputable ads survive", async () => {
  const buy = [p2pAd(1600), p2pAd(1601), p2pAd(1602)];
  const sell = [p2pAd(1590), p2pAd(1591)];
  const provider = new BybitP2PProvider();
  await assert.rejects(
    () => provider.getPriceInNgn(fakeCtx(bybitFetch(buy, sell))),
    /fewer than 3 reputable/,
  );
});

test("BybitP2PProvider reads a percentage completion rate as a fraction", async () => {
  // Bybit reports recentExecuteRate as "98" on some responses, 0.98 on others;
  // with the percentage form the 0.9 filter must not pass a 50% trader.
  const good = [p2pAd(1600, { recentExecuteRate: 98 }), p2pAd(1600, { recentExecuteRate: 98 }), p2pAd(1601, { recentExecuteRate: 98 })];
  const quote = await new BybitP2PProvider().getPriceInNgn(fakeCtx(bybitFetch(good, good)));
  assert.equal(quote.price, 1600);

  const shady = [p2pAd(1600, { recentExecuteRate: 50 }), p2pAd(1600, { recentExecuteRate: 50 }), p2pAd(1601, { recentExecuteRate: 50 })];
  await assert.rejects(
    () => new BybitP2PProvider().getPriceInNgn(fakeCtx(bybitFetch(shady, shady))),
    /fewer than 3 reputable/,
  );
});

test("BybitP2PProvider skips the release-time filter when the field is absent", async () => {
  // The documented endpoint doesn't return avgReleaseTime; a missing value must
  // not be read as an instant release.
  const ads = [1600, 1600, 1601].map((p) => {
    const ad = p2pAd(p) as Record<string, unknown>;
    delete ad.avgReleaseTime;
    return ad;
  });
  const quote = await new BybitP2PProvider().getPriceInNgn(fakeCtx(bybitFetch(ads, ads)));
  assert.equal(quote.price, 1600);
});

test("BybitP2PProvider signs requests and hits the documented endpoint with credentials", async () => {
  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: String(init?.body),
    });
    const items = [p2pAd(1600), p2pAd(1600), p2pAd(1601)];
    return new Response(JSON.stringify({ ret_code: 0, ret_msg: "SUCCESS", result: { count: 3, items } }), { status: 200 });
  }) as typeof fetch;

  const provider = new BybitP2PProvider({ apiKey: "key-123", apiSecret: "secret-456" });
  const quote = await provider.getPriceInNgn(fakeCtx(fetchImpl));

  assert.equal(quote.price, 1600);
  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.match(call.url, /^https:\/\/api\.bybit\.com\/v5\/p2p\/item\/online$/);
    assert.equal(call.headers["X-BAPI-API-KEY"], "key-123");
    assert.equal(call.headers["X-BAPI-RECV-WINDOW"], "5000");
    assert.match(call.headers["X-BAPI-SIGN"]!, /^[0-9a-f]{64}$/); // HMAC-SHA256 hex
    assert.ok(Number(call.headers["X-BAPI-TIMESTAMP"]) > 0);
  }
  // Documented side encoding: "0" buy, "1" sell.
  const sides = seen.map((c) => JSON.parse(c.body).side).sort();
  assert.deepEqual(sides, ["0", "1"]);
});

test("BybitP2PProvider surfaces a non-zero ret_code", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ ret_code: 10001, ret_msg: "Request parameter error: apiKey is missing" }), {
      status: 200,
    })) as typeof fetch;
  const provider = new BybitP2PProvider({ apiKey: "k", apiSecret: "s" });
  await assert.rejects(
    () => provider.getPriceInNgn(fakeCtx(fetchImpl)),
    /Bybit P2P returned 10001: Request parameter error: apiKey is missing/,
  );
});

test("BybitP2PProvider falls over to the next host on a network error", async () => {
  const tried: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    tried.push(url);
    if (url.includes("api.bybit.com")) {
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = { code: "ENOTFOUND" };
      throw err;
    }
    const items = [p2pAd(1600), p2pAd(1600), p2pAd(1601)];
    return new Response(JSON.stringify({ ret_code: 0, result: { items } }), { status: 200 });
  }) as typeof fetch;

  const provider = new BybitP2PProvider({ apiKey: "k", apiSecret: "s" });
  const quote = await provider.getPriceInNgn(fakeCtx(fetchImpl));
  assert.equal(quote.price, 1600);
  assert.ok(tried.some((u) => u.includes("api.bybit.com")));
  assert.ok(tried.some((u) => u.includes("api.bytick.com")));
});

test("BybitP2PProvider reports the underlying cause when every host fails", async () => {
  const fetchImpl = (async () => {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = { code: "ENOTFOUND" };
    throw err;
  }) as typeof fetch;

  const provider = new BybitP2PProvider();
  await assert.rejects(
    () => provider.getPriceInNgn(fakeCtx(fetchImpl)),
    (err: Error) => {
      assert.match(err.message, /Bybit P2P unreachable/);
      assert.match(err.message, /ENOTFOUND/);
      assert.match(err.message, /api2\.bybit\.com/);
      assert.match(err.message, /host did not resolve/);
      return true;
    },
  );
});

test("BybitP2PProvider rejects a half-configured credential pair", () => {
  assert.throws(() => new BybitP2PProvider({ apiKey: "k" }), /both apiKey and apiSecret/);
  assert.throws(() => new BybitP2PProvider({ apiSecret: "s" }), /both apiKey and apiSecret/);
});

test("BybitP2PProvider asset option sets the P2P tokenId", async () => {
  const bodies: Record<string, unknown>[] = [];
  const items = [p2pAd(1600), p2pAd(1600), p2pAd(1601)];
  const provider = new BybitP2PProvider({ asset: "USDC" });
  await provider.getPriceInNgn(fakeCtx(bybitFetch(items, items, (b) => bodies.push(b))));

  assert.equal(provider.asset, "USDC");
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.equal(body.tokenId, "USDC");
    assert.equal(body.currencyId, "NGN");
  }
});

// --- Textile -----------------------------------------------------------------

/** A Textile /tickers row; NGN per stablecoin, decimal strings. */
function textileTicker(over: Record<string, unknown> = {}) {
  return {
    ticker_id: "USDT_NGN",
    base_currency: "USDT",
    target_currency: "NGN",
    last_price: "1394.02",
    bid: "1394.02",
    ask: "1394.28",
    high: "1394.28",
    low: "1394.02",
    base_volume: "0",
    target_volume: "0",
    ...over,
  };
}

/** A /historical_trades row; `at` is seconds before "now". */
function textileTrade(price: number, secondsAgo: number, type: "buy" | "sell" = "sell") {
  return {
    trade_id: `0xabc-${price}-${secondsAgo}`,
    price: String(price),
    base_volume: "100.00",
    target_volume: String(price * 100),
    trade_timestamp: Math.floor(Date.now() / 1000) - secondsAgo,
    type,
  };
}

/** Serves /historical_trades and /tickers off the same fake fetch. */
function textileFetch(
  trades: { buy?: unknown[]; sell?: unknown[] } | unknown,
  tickers: unknown[] = [textileTicker()],
  capture?: (url: string) => void,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    capture?.(url);
    const payload = url.includes("/historical_trades") ? trades : tickers;
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
}

test("TextileProvider quotes a TWAP of cleared trades by default", async () => {
  const urls: string[] = [];
  // 1400 stood for 60s, then 1500 for the final 60s → equal weights.
  const trades = { buy: [], sell: [textileTrade(1400, 120), textileTrade(1500, 60)] };
  const provider = new TextileProvider();
  const quote = await provider.getPriceInNgn(fakeCtx(textileFetch(trades, undefined, (u) => urls.push(u))));

  assert.equal(provider.asset, "USDT");
  assert.equal(urls.length, 1); // no order-book request when trades exist
  assert.match(urls[0]!, /\/historical_trades\?ticker_id=USDT_NGN&limit=200&start_time=\d+$/);
  assert.ok(Math.abs(quote.price - 1450) < 5, `expected ~1450, got ${quote.price}`);
});

test("TextileProvider weights each trade by how long it stood as the last price", async () => {
  // 1400 held for 90 of the last 100 seconds; 1500 only for the last 10.
  const trades = { sell: [textileTrade(1400, 100), textileTrade(1500, 10)] };
  const quote = await new TextileProvider().getPriceInNgn(fakeCtx(textileFetch(trades)));
  const expected = (1400 * 90 + 1500 * 10) / 100;
  assert.ok(Math.abs(quote.price - expected) < 5, `expected ~${expected}, got ${quote.price}`);
});

test("TextileProvider merges both sides and tolerates duplicate timestamps", async () => {
  // One order filling in three prints at the same second, newest-first as served.
  const trades = {
    buy: [textileTrade(1500, 0, "buy")],
    sell: [textileTrade(1400, 300), textileTrade(1400, 300), textileTrade(1400, 300)],
  };
  const quote = await new TextileProvider().getPriceInNgn(fakeCtx(textileFetch(trades)));
  // The 1400 prints clamp to 1ms each; 1400 then stands for ~300s before 1500.
  assert.ok(quote.price > 1400 && quote.price < 1410, `expected ~1400, got ${quote.price}`);
});

test("TextileProvider TWAP of a single trade is that trade's price", async () => {
  const quote = await new TextileProvider().getPriceInNgn(
    fakeCtx(textileFetch({ sell: [textileTrade(1393.86, 45)] })),
  );
  assert.equal(quote.price, 1393.86);
});

test("TextileProvider falls back to the book mid when no trades cleared", async () => {
  const urls: string[] = [];
  const quote = await new TextileProvider().getPriceInNgn(
    fakeCtx(textileFetch({ buy: [], sell: [] }, undefined, (u) => urls.push(u))),
  );
  assert.equal(quote.price, (1394.02 + 1394.28) / 2);
  assert.equal(urls.length, 2);
  assert.match(urls[1]!, /\/tickers\?ticker_id=USDT_NGN$/);
  assert.equal((quote.raw as { twapFellBackTo?: string }).twapFellBackTo, "mid");
});

test("TextileProvider twapFallback: false throws instead of quoting the book", async () => {
  const provider = new TextileProvider({ twapFallback: false });
  await assert.rejects(
    () => provider.getPriceInNgn(fakeCtx(textileFetch({ buy: [], sell: [] }))),
    /no Textile trades cleared for "USDT_NGN" in the last 3600000ms/,
  );
});

test("TextileProvider twapWindowMs sets start_time and twapLimit is capped at 1000", async () => {
  const urls: string[] = [];
  const provider = new TextileProvider({ twapWindowMs: 600_000, twapLimit: 5000 });
  await provider.getPriceInNgn(
    fakeCtx(textileFetch({ sell: [textileTrade(1400, 60)] }, undefined, (u) => urls.push(u))),
  );

  const startTime = Number(/start_time=(\d+)/.exec(urls[0]!)?.[1]);
  const expected = Math.floor((Date.now() - 600_000) / 1000);
  assert.ok(Math.abs(startTime - expected) <= 2, `start_time ${startTime} vs ~${expected}`);
  assert.match(urls[0]!, /limit=1000&/);
});

test("TextileProvider rejects a nonsensical TWAP window or limit", () => {
  assert.throws(() => new TextileProvider({ twapWindowMs: 0 }), /twapWindowMs must be positive|positive number/);
  assert.throws(() => new TextileProvider({ twapLimit: 0 }), /twapLimit must be a positive integer/);
});

test("TextileProvider asset option switches the corridor to <asset>_NGN", async () => {
  const urls: string[] = [];
  const provider = new TextileProvider({ asset: "USDC" });
  await provider.getPriceInNgn(
    fakeCtx(textileFetch({ sell: [textileTrade(1400, 60)] }, undefined, (u) => urls.push(u))),
  );

  assert.equal(provider.asset, "USDC");
  assert.match(urls[0]!, /ticker_id=USDC_NGN&/);
});

test("TextileProvider price option reads the order book instead of trades", async () => {
  const payload = [textileTicker()];
  const mid = await new TextileProvider({ price: "mid" }).getPriceInNgn(fakeCtx(jsonFetch(payload)));
  const last = await new TextileProvider({ price: "last" }).getPriceInNgn(
    fakeCtx(jsonFetch(payload)),
  );
  const bid = await new TextileProvider({ price: "bid" }).getPriceInNgn(fakeCtx(jsonFetch(payload)));
  const ask = await new TextileProvider({ price: "ask" }).getPriceInNgn(fakeCtx(jsonFetch(payload)));

  assert.equal(mid.price, (1394.02 + 1394.28) / 2);
  assert.equal(last.price, 1394.02);
  assert.equal(bid.price, 1394.02);
  assert.equal(ask.price, 1394.28);
});

test("TextileProvider mid falls back to last_price when a side of the book is missing", async () => {
  const payload = [textileTicker({ bid: "0", ask: null })];
  const quote = await new TextileProvider({ price: "mid" }).getPriceInNgn(
    fakeCtx(jsonFetch(payload)),
  );
  assert.equal(quote.price, 1394.02);
});

test("TextileProvider picks the matching ticker out of a multi-pair feed", async () => {
  const payload = [
    textileTicker({ ticker_id: "WETH_USDT", last_price: "1918", bid: "1917", ask: "1919" }),
    textileTicker({ ticker_id: "USDT_NGN" }),
  ];
  const quote = await new TextileProvider({ price: "mid", tickerId: "usdt_ngn" }).getPriceInNgn(
    fakeCtx(jsonFetch(payload)),
  );
  assert.equal(quote.price, (1394.02 + 1394.28) / 2);
});

test("TextileProvider surfaces the feed's error object", async () => {
  const book = new TextileProvider({ price: "mid", tickerId: "NOPE_NGN" });
  await assert.rejects(
    () => book.getPriceInNgn(fakeCtx(jsonFetch({ error: "unknown ticker_id" }))),
    /unexpected Textile response for "NOPE_NGN": unknown ticker_id/,
  );

  const twap = new TextileProvider({ tickerId: "NOPE_NGN" });
  await assert.rejects(
    () => twap.getPriceInNgn(fakeCtx(jsonFetch({ error: "unknown ticker_id" }))),
    /unexpected Textile trades response for "NOPE_NGN": unknown ticker_id/,
  );
});

test("TextileProvider throws when the ticker feed returns an empty array", async () => {
  const provider = new TextileProvider({ price: "mid" });
  await assert.rejects(
    () => provider.getPriceInNgn(fakeCtx(jsonFetch([]))),
    /no ticker for "USDT_NGN"/,
  );
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
