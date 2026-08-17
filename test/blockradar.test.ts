import { test } from "node:test";
import assert from "node:assert/strict";
import { BlockradarProvider } from "../src/providers/blockradar.js";
import type { ProviderContext } from "../src/types.js";

/** Builds a ProviderContext backed by a fake fetch, so no network is hit. */
function fakeCtx(fetchImpl: typeof fetch): ProviderContext {
  return { signal: new AbortController().signal, fetch: fetchImpl };
}

test("parses bestRate and sends the api key header", async () => {
  let seenUrl: string | undefined;
  let seenHeaders: HeadersInit | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seenUrl = String(input);
    seenHeaders = init?.headers;
    return new Response(
      JSON.stringify({ data: { fromAsset: "USDT", toAsset: "cNGN", bestRate: "1547.50" } }),
      { status: 200 },
    );
  }) as typeof fetch;

  const provider = new BlockradarProvider({ apiKey: "secret-key", price: "benchmark" });
  const quote = await provider.getUsdtPriceInNgn(fakeCtx(fetchImpl));

  assert.equal(quote.price, 1547.5);
  assert.match(seenUrl ?? "", /fromAsset=USDT&toAsset=cNGN/);
  assert.equal((seenHeaders as Record<string, string>)["x-api-key"], "secret-key");
});

test("throws when bestRate is null", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ data: { fromAsset: "USDT", toAsset: "cNGN", bestRate: null } }),
      { status: 200 },
    )) as typeof fetch;

  const provider = new BlockradarProvider({ apiKey: "secret-key", price: "benchmark" });
  await assert.rejects(() => provider.getUsdtPriceInNgn(fakeCtx(fetchImpl)));
});

test("throws on a non-2xx response", async () => {
  const fetchImpl = (async () =>
    new Response("unauthorized", { status: 401, statusText: "Unauthorized" })) as typeof fetch;

  const provider = new BlockradarProvider({ apiKey: "bad-key", price: "benchmark" });
  await assert.rejects(() => provider.getUsdtPriceInNgn(fakeCtx(fetchImpl)));
});

test("the rates path also fails when every route 401s", async () => {
  const fetchImpl = (async () =>
    new Response("unauthorized", { status: 401, statusText: "Unauthorized" })) as typeof fetch;

  const provider = new BlockradarProvider({ apiKey: "bad-key" });
  await assert.rejects(
    () => provider.getUsdtPriceInNgn(fakeCtx(fetchImpl)),
    /no Blockradar rate routes available/,
  );
});
