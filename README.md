# cngn-rate-picker

Resilient **NGN ⇄ USD-stablecoin** exchange-rate library for TypeScript:
**USDT** and **USDC** out of the box, and any future USD-backed stablecoin
without a library update. Query multiple rate providers behind one interface:
every eligible provider is queried on every request, and the top-priority
successes are combined into a single time-weighted rate, with every
individual provider's quote still visible in the response. Zero runtime
dependencies, works in Node 18+ and modern browsers.

## Install

```bash
npm install cngn-rate-picker
```

## Why the design looks like this

The library composes three classic patterns, each doing one job:

| Pattern | Where | What it buys you |
| --- | --- | --- |
| **Strategy** | `RateProvider` interface | Providers are interchangeable. Add, remove, or reorder them without touching the picker. |
| **Adapter** | each `*Provider` class | Each upstream API has a different response shape; the adapter normalises it to one `ProviderQuote` (`NGN per 1 unit of the stablecoin`). |
| **Scatter-Gather** | `ExchangeRatePicker` | Every eligible provider is queried on every request (scatter), and the top-priority successes are combined into one time-weighted rate (gather); see "Threshold" below. |

On top of that the picker adds a **circuit breaker** (skip a provider that keeps
failing, retry it after a cooldown), a per-provider **timeout**, and an optional
**TTL cache**. It acts as a **facade**: callers only see
`getStablecoinToNgn()`, `getNgnToStablecoin()`, and `convert()` (plus the
`getUsdtToNgn()`/`getNgnToUsdt()` sugar on USDT pickers).

Everything canonicalises to a single number, *NGN per 1 unit of the picker's
stablecoin*, so providers stay tiny and both conversion directions are
derived in one place.

## Choosing your stablecoin (USDC and beyond)

**One picker = one market.** A picker trades exactly one USD-backed
stablecoin against NGN, set by the `asset` option (default `"USDT"`). This
keeps the TWAP honest: quotes for different coins are never mixed into one
average. Want both USDT and USDC rates? Create two pickers; they're cheap.

```ts
const usdc = new ExchangeRatePicker({
  asset: "USDC",
  providers: [
    new TextileProvider({ asset: "USDC" }),     // USDC_NGN corridor
    new QuidaxProvider({ asset: "USDC" }),      // cNGN/USDC market
    new BybitP2PProvider({ asset: "USDC" }),    // USDC/NGN P2P street rate
  ],
});

const rate = await usdc.getStablecoinToNgn();   // NGN per 1 USDC
await usdc.convert(50_000, "NGN", "USDC");
```

Three rules make this safe and extensible:

1. **Providers declare what they quote** via an optional `asset` field
   (default `"USDT"`). The picker throws **at construction** if a provider's
   asset doesn't match its own: a USDC provider can't silently poison a USDT
   average.
2. **`"USD"` marks a fiat proxy.** A provider whose `asset` is `"USD"` (an
   official FX rate, say) is accepted by every picker, on the assumption the
   stablecoin holds its peg. No built-in provider declares `"USD"` any more, so
   the hook is there for your own.
3. **New coins need no library update.** `asset` accepts any symbol
   (`"PYUSD"`, `"FDUSD"`, …); `"USDT"` and `"USDC"` merely get
   autocompletion. Point the built-in providers at the new market
   (`QuidaxProvider({ asset: "PYUSD", market: "..." })`,
   `TextileProvider({ asset: "PYUSD" })`) or write a tiny provider of your own.

> Quidax listings vary: the provider builds the market id as
> `cngn<asset-lowercased>` (e.g. `cngnusdc`) and fails over cleanly if the
> exchange doesn't list that market. Pass `market` explicitly if the id
> doesn't follow that pattern, and verify a market actually exists before
> relying on it in production. As of July 2026 Quidax lists `cngnusdt` but
> **not** `cngnusdc`, so a practical USDC picker today leans on
> `TextileProvider({ asset: "USDC" })` and
> `BlockradarProvider({ apiKey, asset: "USDC" })`.

## Built-in providers

| Provider | Source | Rate type | TWAP? | Assets | Key? |
| --- | --- | --- | --- | --- | --- |
| `QuidaxProvider` | Quidax cNGN/&lt;asset&gt; kline | Live crypto **market** rate | ✅ candle closes | Any listed market (`asset`/`market` options) | No |
| `TextileProvider` | Textile Credit FX feed (&lt;asset&gt;\_NGN corridor) | Live **order-book** venue rate | ✅ cleared trades | Any published corridor (`asset`/`tickerId` options) | No |
| `BlockradarProvider` | Blockradar `/assets/rates` routes | Wallet-provider **settlement** rate (both directions averaged) | ❌ no history, cross-route average instead | Any listed asset (`asset` option) | Yes |
| `BybitP2PProvider` | Bybit P2P &lt;asset&gt;/NGN ads | **Parallel/street** rate (fraud-filtered P2P mid) | ❌ see below | Any P2P-listed token (`asset` option) | Optional |

### TWAP by default

Every provider with a usable upstream time series quotes a **time-weighted
average price**, not a spot value. NGN stablecoin corridors are thin, so one
large print or a momentarily skewed book moves a spot quote far more than it
moves the real clearing level, and the picker would bake that into a
settlement rate.

Both of them share one weighting rule (`timeWeightedAverage` in `src/twap.ts`,
exported if you want it for your own provider): each observation is weighted by
**how long it stood as the most recent one**, with the newest weighted up to
now. That's the average of the stepwise-constant price series, so a dense burst
of prints can't outvote a price that actually held. Observations sharing a
timestamp clamp to 1 ms so each still counts. Each provider takes
`twapWindowMs` (default 1 hour) and a `price` option to opt back into spot.

The two that *don't* TWAP can't, rather than don't:

- **`BlockradarProvider`**: neither of its endpoints exposes history, just a
  scalar per route. It averages across routes instead of across time.
- **`BybitP2PProvider`**: P2P ads are standing *quotes*, not executions, so
  there is no trade history to weight. Its median-filter-then-mode over current
  ads is the cross-sectional analogue, doing the job a TWAP would.

> Note this is a TWAP *within* each provider. The picker's `threshold` option
> applies a second, cross-provider TWAP over one quote per provider; see
> [Threshold (TWAP averaging)](#threshold-twap-averaging). The two compose:
> each provider contributes one time-weighted number to that average.

> **Choose your ordering deliberately.** In Nigeria the *official* rate can sit
> well below the *crypto/parallel* rate. Put a market source (Quidax/Textile)
> first so it's the one used whenever it succeeds, and treat the official rate
> as a graceful-degradation choice for when it doesn't; otherwise your
> numbers will silently drift from the street rate. Note that with the
> default `threshold: 1`, ordering only decides *which* successful quote is
> used, not *whether* a provider gets called: every configured provider is
> queried on every request regardless of position.

> `QuidaxProvider` averages the public kline series (`/markets/{market}/k`),
> weighting each candle's close by how long it stood. `klinePeriodMinutes` sets
> the candle size (default 1). It also carries a **staleness guard**
> (`maxStalenessMs`, default 6 h, `false` to disable): Quidax keeps serving the
> last price of a market that has stopped trading, and a months-old number
> quietly averaged into a settlement rate is worse than no quote at all, so the
> provider throws and the picker fails it over.
>
> The default market is `<asset>cngn` (e.g. `usdtcngn`), which quotes cNGN per
> asset directly and so needs no inversion. The provider infers the direction
> from the market id: an id starting with the asset symbol is read as cNGN/NGN
> per asset, anything else (`cngnusdt`) as asset per cNGN. `invert` overrides
> the inference.
>
> ⚠️ **Not every cNGN market on Quidax is alive.** As of 2026-08-17 the
> reversed `cngnusdt` market has not traded in ~6 months (every candle
> zero-volume, its ticker still reporting ~1477 against ~1394 on live venues)
> and `cngnusdc` serves an empty series, while `usdtcngn` is fresh at ~1395.
> The staleness guard is what keeps a dormant market from contributing that
> stale outlier, so verify any market override before relying on it.

```ts
import { QuidaxProvider } from "cngn-rate-picker";

new QuidaxProvider();                          // usdtcngn, 1h TWAP of candle closes
new QuidaxProvider({ market: "usdtngn" });     // the NGN (not cNGN) market
new QuidaxProvider({ price: "spot" });         // ticker `last`, pre-TWAP behaviour
new QuidaxProvider({ maxStalenessMs: false }); // quote a dormant market anyway
```

> `BlockradarProvider` requires an API key (`apiKey` option, sent as the
> `x-api-key` header). By default it reads the public `/assets/rates` feed for
> the configured asset in **both directions** (`cNGN→<asset>` and
> `<asset>→cNGN`), queried in parallel and normalised to USD per cNGN before
> being averaged, then inverted to this library's NGN-per-asset contract. One
> broken or missing direction degrades the quote instead of failing it, and
> `raw.failedRoutes` records what dropped out. Neither endpoint exposes
> history, so this is a cross-route average rather than a TWAP.
>
> `price: "benchmark"` reads `/rates/market-benchmark` instead, which reflects
> *other* Liquidity Providers' rates in your business segment rather than a
> market price. That is useful for competitive benchmarking, but only as
> informative as the peer set Blockradar compares you against.
>
> `allRoutes: true` blends the other stablecoin's routes into the same average,
> matching upstream reference implementations that treat cNGN/USD as one
> number. It is off by default because this library keeps one picker to one
> stablecoin.

```ts
import { BlockradarProvider } from "cngn-rate-picker";

new BlockradarProvider({ apiKey: process.env.BLOCKRADAR_API_KEY! });
new BlockradarProvider({ apiKey, asset: "USDC" });
new BlockradarProvider({ apiKey, price: "benchmark" }); // competing-LP rate
```

> `BybitP2PProvider` reads live P2P advertisements and applies fraud
> filtering before quoting: ads must come from reputable online traders
> (≥100 completed orders, ≥90% completion rate, fast release), prices more
> than 2% off the per-side median are discarded, and the quote is the mid of
> the modal buy/ask and sell/bid prices. All thresholds are configurable via
> options.
>
> It speaks two transports. **Without credentials** it calls
> `api2.bybit.com/fiat/otc/item/online`, the keyless endpoint behind Bybit's own
> P2P web UI. That is not a documented public API, so treat it as best-effort
> and pair it with other providers rather than relying on it alone.
>
> **With `apiKey` + `apiSecret`** it calls the documented
> [`POST /v5/p2p/item/online`](https://bybit-exchange.github.io/docs/p2p/ad/online-ad-list),
> signing each request per the
> [P2P auth spec](https://bybit-exchange.github.io/docs/p2p/guide)
> (HMAC-SHA256 over `timestamp + apiKey + recvWindow + body`, sent as the
> `X-BAPI-*` headers). Note Bybit restricts the P2P API to accounts with
> **General Advertiser status or above**, so keys from an ordinary account are
> rejected; the keyless transport is the only option without that status.
>
> ⚠️ **If you see `[bybit-p2p] fetch failed`, it is almost certainly DNS.**
> Many networks and resolvers block `bybit.com` outright. Bybit documents
> `api.bytick.com` as an equivalent mainnet host, so the official transport
> tries both in order and only fails when every host does. The keyless
> `api2.bybit.com` host has no such alias, so a resolver that blocks
> `bybit.com` leaves that transport with nowhere to go. Provider errors now name
> the underlying cause (`ENOTFOUND`, `ECONNREFUSED`, and so on) and the host
> that failed, instead of a bare "fetch failed".

```ts
import { BybitP2PProvider } from "cngn-rate-picker";

new BybitP2PProvider();                    // keyless, USDT/NGN street rate
new BybitP2PProvider({ asset: "USDC" });   // any token Bybit P2P lists vs NGN
new BybitP2PProvider({                     // documented API, tries both hosts
  apiKey: process.env.BYBIT_API_KEY!,
  apiSecret: process.env.BYBIT_API_SECRET!,
});
new BybitP2PProvider({ hosts: ["https://api.bytick.com"] }); // skip a blocked host
```

> `TextileProvider` reads the public, unauthenticated
> [Textile Credit FX feed](https://fx-docs.textilecredit.com/api/rates.html).
> It follows the CoinGecko convention: prices are target per base, so
> `USDT_NGN` is already NGN per USDT, and Textile publishes cNGN as plain
> `NGN` since the two are pegged 1:1. Unknown pairs return 404, which fails the
> provider over cleanly.
>
> **By default it quotes a TWAP of cleared trades** from
> `GET /historical_trades`, not a quote off the book: both sides are merged and
> each trade is weighted by how long it stood as the last cleared price, so a
> single large print or a momentarily skewed book can't move the rate much.
> `twapWindowMs` sets the lookback (default 1 hour) and `twapLimit` the trades
> requested per side (default 200, capped by the feed at 1000).
>
> If nothing cleared in the window, it falls back to the order book's bid/ask
> mid (`bid`/`ask` are top-of-book and **net of fees**) and records
> `raw.twapFellBackTo`. Set `twapFallback: false` to throw instead and let
> another provider supply the rate, or set `price` to read the book directly.

```ts
import { TextileProvider } from "cngn-rate-picker";

new TextileProvider();                             // USDT_NGN, 1h TWAP of cleared trades
new TextileProvider({ asset: "USDC" });            // USDC_NGN
new TextileProvider({ twapWindowMs: 15 * 60_000 }); // shorter, more responsive window
new TextileProvider({ twapFallback: false });      // never mix a book quote into the TWAP
new TextileProvider({ price: "mid" });             // skip trades, quote the live book
new TextileProvider({ price: "bid" });             // the side you'd sell into
new TextileProvider({ tickerId: "USDT_NGN" });     // explicit corridor override
```

> Of the three TWAP providers this is the only one averaging *executions*:
> Quidax averages candle closes, so Textile is the closest thing here to a
> true cleared-price rate.

## Options

```ts
new ExchangeRatePicker({
  providers,                 // required, in priority order
  asset: "USDT",             // the USD stablecoin this picker trades vs NGN
  timeoutMs: 5000,           // per-provider timeout
  cacheTtlMs: 0,             // 0 = no cache
  threshold: 1,              // how many (by priority) feed the TWAP; every provider is queried regardless
  parallel: false,           // true = query providers concurrently instead of one at a time
  circuitBreaker: {          // or `false` to disable
    failureThreshold: 3,     // consecutive failures before skipping
    cooldownMs: 30_000,      // how long to skip before a retry
  },
  fetch: globalThis.fetch,   // inject a custom fetch (proxy, mock, metrics)
  onProviderError: (e) => {},
  onSuccess: (rate) => {},
});
```

## Threshold (TWAP averaging)

There is no early exit: **every eligible provider is queried on every
request**, whether `threshold` is 1 or the full length of `providers`. What
`threshold` controls is how many of those successes, the first N in
provider-priority order, get folded into the single rate you receive:

- The rate you get (`rate.rate`) is a **time-weighted average (TWAP)** of
  the first `threshold` successes, in provider-priority order: a quote that
  stayed the "current" answer for longer (before the next one landed)
  counts for more than one that was almost instantly superseded. A plain
  average would let arrival order silently distort the result; TWAP makes
  the timing part of the signal instead of noise. With the default
  `threshold: 1` this collapses to the top-priority provider's own price.
- Every provider's quote, whether it fed the average or not, shows up in
  `rate.sources`, each tagged with `usedInAverage` so you can tell which
  ones contributed to `rate.rate`.

```ts
const picker = new ExchangeRatePicker({
  providers: [
    new QuidaxProvider(),
    new TextileProvider(),
    new BybitP2PProvider(),
    new BlockradarProvider({ apiKey: process.env.BLOCKRADAR_API_KEY! }),
  ],
  threshold: 3, // TWAP the first 3 (by priority) that succeed; all 4 are queried either way
});

const rate = await picker.getUsdtToNgn();
console.log(rate.rate);      // TWAP of the first 3 successes
console.log(rate.provider);  // e.g. "quidax, textile, bybit-p2p"
console.log(rate.sources);   // every provider's quote: { provider, price, raw, fetchedAt, usedInAverage }
```

`parallel` only changes *how* providers are queried, not *how many*. Every
eligible provider is always queried:

| Mode | `parallel` | Behaviour |
| --- | --- | --- |
| Sequential (default) | `false` | Providers are called **one at a time**, in order, all the way through the list. |
| Concurrent | `true` | Every eligible (non-circuit-open) provider is called **at once** and the picker waits for all of them; lower latency (bounded by the slowest, not the sum), same total calls. |

Failed or circuit-open providers are skipped and don't count toward
`threshold`, but they don't block it either; the picker just moves on.

- If **at least one but fewer than `threshold`** providers succeed, it
  throws `ThresholdNotMetError` (`.threshold`, `.succeeded`, `.errors`).
- If **none** succeed, it throws `AllProvidersFailedError`.
- `threshold` must be a positive integer and **cannot exceed the number of
  configured providers**: `new ExchangeRatePicker({ providers, threshold: 6 })`
  with only 5 providers throws synchronously at construction time.

## Writing your own provider

Implement one method, declare what you quote. That's the whole contract.

```ts
import { RateProvider, ProviderContext, ProviderQuote, httpJson, toPrice } from "cngn-rate-picker";

export class MyExchangeProvider implements RateProvider {
  readonly name = "my-exchange";
  readonly asset = "USDC"; // what this provider quotes; omit for USDT, "USD" for a fiat proxy

  async getPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    const body = await httpJson<{ price: string }>(
      "https://api.my-exchange.com/usdc-ngn",
      { ctx }, // ctx carries the injected fetch + timeout signal
    );
    return { price: toPrice(body.price), raw: body };
  }
}
```

Pre-0.2 providers that implement `getUsdtPriceInNgn` still work and are
treated as quoting USDT, but new providers should use `getPriceInNgn`.

Drop it anywhere in the `providers` array and the averaging, breaker, cache,
and events apply to it automatically.

## Error handling

```ts
import { AllProvidersFailedError } from "cngn-rate-picker";

try {
  const rate = await picker.getUsdtToNgn();
} catch (err) {
  if (err instanceof AllProvidersFailedError) {
    // err.errors is a ProviderError[], one entry per provider that failed
  }
}
```

## Scripts

```bash
npm run build      # compile to dist/
npm test           # run the test suite (node --test)
npm run typecheck  # type-check without emitting
```

## Contributing

Contributions are welcome: new providers, bug fixes, docs, and test coverage
alike. The codebase is small and dependency-free on purpose; please keep it
that way.

### Getting started

You need **Node 18+** and npm. Then:

```bash
git clone https://github.com/wrappedcbdc/cngn-rate-picker.git
cd cngn-rate-picker
npm install        # dev dependencies only (typescript, tsx)
npm test           # everything should be green before you start
```

### Project layout

```
src/
├── index.ts       # public API barrel, every export goes through here
├── picker.ts      # ExchangeRatePicker: TWAP averaging, cache, circuit breaker
├── types.ts       # shared contracts (Rate, RateProvider, ProviderQuote)
├── errors.ts      # ProviderError, AllProvidersFailedError
├── http.ts        # httpJson + toPrice helpers used by all providers
├── twap.ts        # timeWeightedAverage, shared by every TWAP provider
└── providers/     # one file per upstream API adapter
test/              # node:test suites (no network, use fake providers)
examples/          # runnable usage examples
```

### Adding a provider

This is the most common contribution. The checklist:

1. Create `src/providers/<name>.ts` implementing `RateProvider`: one class,
   one `getPriceInNgn(ctx)` method, plus an `asset` field (or an `asset`
   option) saying which stablecoin it quotes. Use `httpJson` and `toPrice`
   from `../http.js` rather than calling `fetch` directly, so the injected
   fetch, timeout signal, and price validation apply automatically.
2. Make the base URL a constructor parameter with a default (see
   `QuidaxProvider`) so tests can point it at a mock.
3. **Quote a TWAP, not a spot price**, whenever the upstream exposes any time
   series (trade history, klines, a chart endpoint). Map it to `PricePoint[]`
   and call `timeWeightedAverage` from `../twap.js` so every provider weights
   identically; take a `twapWindowMs` option and offer `price: "spot"` as the
   escape hatch. Only fall back to a spot value when the upstream genuinely has
   no history; say so in the docs, as `BlockradarProvider` does. If the upstream can serve a dormant market, guard
   on staleness rather than averaging a months-old price.
4. Export the class (and any options type) from `src/index.ts`.
5. Add tests in `test/`. Tests must not hit the network: inject a fake
   `fetch` via the picker options or call the provider with a stubbed
   `ProviderContext`. For TWAP providers, keep fixture timestamps clear of the
   window edge: a point stamped exactly at `now - twapWindowMs` drops out once
   the provider stamps its own `now`, which makes for a flaky test.
6. Document it in the "Built-in providers" table above, including the rate
   type (market vs official), whether it TWAPs, and any reliability caveats.
   Unofficial or undocumented endpoints must be clearly flagged as such.

Remember the one canonical rule: providers report a single number, **NGN per
1 unit of their declared asset**, as a finite, positive value, and throw on
any failure. The picker handles everything else (asset matching, retries,
TWAP averaging, caching, inversion).

### Pull request guidelines

- Before opening a PR, make sure all three pass locally:
  `npm run typecheck`, `npm test`, and `npm run build`.
- Keep PRs focused: one provider or one fix per PR is much easier to review
  than a grab bag.
- **No new runtime dependencies.** Zero-dependency is a feature of this
  library; PRs that add one will be asked to remove it. Dev dependencies are
  negotiable if they clearly pay for themselves.
- Every behaviour change needs a test that fails without the change.
- Match the existing style: ES modules with explicit `.js` extensions in
  import paths (required by `NodeNext` resolution), strict TypeScript, and
  doc comments on anything exported.
- If you're changing the public API or the averaging semantics, open an issue
  first so the design can be discussed before you invest the time.

### Reporting bugs

Open an issue with the library version, Node version, a minimal reproduction,
and, if a provider is involved, the raw upstream payload if you have it
(`Rate.raw` is kept for exactly this). Please **do not** include API keys or
account details in issues.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full release history. Highlights of
**0.2.0**: USDC support, an `asset` option on the picker, provider-declared
assets with construction-time validation, and extensibility to any future
USD-backed stablecoin.

## Disclaimer

Rates are sourced from third-party public endpoints and provided as-is for
informational purposes. Verify against your settlement source before moving
money. This project is not affiliated with Quidax, Textile, Blockradar, or
any rate provider.

## License

MIT
