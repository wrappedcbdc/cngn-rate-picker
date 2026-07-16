# cngn-rate-picker

Resilient **NGN ⇄ USD-stablecoin** exchange-rate library for TypeScript —
**USDT** and **USDC** out of the box, and any future USD-backed stablecoin
without a library update. Query multiple rate providers behind one interface:
every eligible provider is queried on every request, and the top-priority
successes are combined into a single time-weighted rate — with every
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
| **Scatter-Gather** | `ExchangeRatePicker` | Every eligible provider is queried on every request (scatter), and the top-priority successes are combined into one time-weighted rate (gather) — see "Threshold" below. |

On top of that the picker adds a **circuit breaker** (skip a provider that keeps
failing, retry it after a cooldown), a per-provider **timeout**, and an optional
**TTL cache**. It acts as a **facade**: callers only see
`getStablecoinToNgn()`, `getNgnToStablecoin()`, and `convert()` (plus the
`getUsdtToNgn()`/`getNgnToUsdt()` sugar on USDT pickers).

Everything canonicalises to a single number — *NGN per 1 unit of the picker's
stablecoin* — so providers stay tiny and both conversion directions are
derived in one place.

## Choosing your stablecoin (USDC and beyond)

**One picker = one market.** A picker trades exactly one USD-backed
stablecoin against NGN, set by the `asset` option (default `"USDT"`). This
keeps the TWAP honest: quotes for different coins are never mixed into one
average. Want both USDT and USDC rates? Create two pickers — they're cheap.

```ts
const usdc = new ExchangeRatePicker({
  asset: "USDC",
  providers: [
    new QuidaxProvider({ asset: "USDC" }),      // cNGN/USDC market
    new CoinGeckoProvider({ asset: "USDC" }),   // usd-coin price in NGN
    new ExchangeRateApiProvider(),              // fiat-USD proxy — matches any picker
  ],
});

const rate = await usdc.getStablecoinToNgn();   // NGN per 1 USDC
await usdc.convert(50_000, "NGN", "USDC");
```

Three rules make this safe and extensible:

1. **Providers declare what they quote** via an optional `asset` field
   (default `"USDT"`). The picker throws **at construction** if a provider's
   asset doesn't match its own — a USDC provider can't silently poison a USDT
   average.
2. **`"USD"` marks a fiat proxy.** A provider whose `asset` is `"USD"`
   (e.g. `ExchangeRateApiProvider`, an official FX rate) is accepted by every
   picker, on the assumption the stablecoin holds its peg.
3. **New coins need no library update.** `asset` accepts any symbol
   (`"PYUSD"`, `"FDUSD"`, …) — `"USDT"` and `"USDC"` merely get
   autocompletion. Point the built-in providers at the new market
   (`QuidaxProvider({ asset: "PYUSD", market: "..." })`,
   `CoinGeckoProvider({ asset: "PYUSD", coinId: "paypal-usd" })`) or write a
   tiny provider of your own.

> Quidax listings vary: the provider builds the market id as
> `cngn<asset-lowercased>` (e.g. `cngnusdc`) and fails over cleanly if the
> exchange doesn't list that market. Pass `market` explicitly if the id
> doesn't follow that pattern, and verify a market actually exists before
> relying on it in production — as of July 2026 Quidax lists `cngnusdt` but
> **not** `cngnusdc`, so a practical USDC picker today leans on
> `CoinGeckoProvider({ asset: "USDC" })`, `ExchangeRateApiProvider`, and
> `BlockradarProvider({ apiKey, asset: "USDC" })`.

## Built-in providers

| Provider | Source | Rate type | Assets | Key? |
| --- | --- | --- | --- | --- |
| `QuidaxProvider` | Quidax cNGN/&lt;asset&gt; ticker | Live crypto **market** rate | Any listed market (`asset`/`market` options) | No |
| `CoinGeckoProvider` | CoinGecko simple price | Aggregated market rate | USDT, USDC built in; others via `coinId` | No |
| `ExchangeRateApiProvider` | open.er-api.com USD→NGN | **Official** rate (fiat-USD proxy) | Any USD stablecoin | No |
| `BlockradarProvider` | Blockradar market benchmark (&lt;asset&gt;/cNGN) | Best competing **Liquidity Provider** rate | Any benchmarked asset (`asset` option) | Yes |

> **Choose your ordering deliberately.** In Nigeria the *official* rate can sit
> well below the *crypto/parallel* rate. Put a market source (Quidax/CoinGecko)
> first so it's the one used whenever it succeeds, and treat the official rate
> as a graceful-degradation choice for when it doesn't — otherwise your
> numbers will silently drift from the street rate. Note that with the
> default `threshold: 1`, ordering only decides *which* successful quote is
> used, not *whether* a provider gets called — every configured provider is
> queried on every request regardless of position.

> `BlockradarProvider` requires an API key (`apiKey` option, sent as the
> `x-api-key` header) and reflects *other* Liquidity Providers' rates in your
> business segment, not a public exchange price — useful for competitive
> benchmarking, but only as informative as the peer set Blockradar compares
> you against.

```ts
import { BlockradarProvider } from "cngn-rate-picker";

new BlockradarProvider({ apiKey: process.env.BLOCKRADAR_API_KEY! });
```

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
`threshold` controls is how many of those successes — the first N in
provider-priority order — get folded into the single rate you receive:

- The rate you get (`rate.rate`) is a **time-weighted average (TWAP)** of
  the first `threshold` successes, in provider-priority order: a quote that
  stayed the "current" answer for longer (before the next one landed)
  counts for more than one that was almost instantly superseded. A plain
  average would let arrival order silently distort the result; TWAP makes
  the timing part of the signal instead of noise. With the default
  `threshold: 1` this collapses to the top-priority provider's own price.
- Every provider's quote — whether it fed the average or not — shows up in
  `rate.sources`, each tagged with `usedInAverage` so you can tell which
  ones contributed to `rate.rate`.

```ts
const picker = new ExchangeRatePicker({
  providers: [
    new QuidaxProvider(),
    new CoinGeckoProvider(),
    new ExchangeRateApiProvider(),
    new BlockradarProvider({ apiKey: process.env.BLOCKRADAR_API_KEY! }),
  ],
  threshold: 3, // TWAP the first 3 (by priority) that succeed; all 4 are queried either way
});

const rate = await picker.getUsdtToNgn();
console.log(rate.rate);      // TWAP of the first 3 successes
console.log(rate.provider);  // e.g. "quidax, coingecko, exchangerate-api"
console.log(rate.sources);   // every provider's quote: { provider, price, raw, fetchedAt, usedInAverage }
```

`parallel` only changes *how* providers are queried, not *how many* — every
eligible provider is always queried:

| Mode | `parallel` | Behaviour |
| --- | --- | --- |
| Sequential (default) | `false` | Providers are called **one at a time**, in order, all the way through the list. |
| Concurrent | `true` | Every eligible (non-circuit-open) provider is called **at once** and the picker waits for all of them — lower latency (bounded by the slowest, not the sum), same total calls. |

Failed or circuit-open providers are skipped and don't count toward
`threshold`, but they don't block it either — the picker just moves on.

- If **at least one but fewer than `threshold`** providers succeed, it
  throws `ThresholdNotMetError` (`.threshold`, `.succeeded`, `.errors`).
- If **none** succeed, it throws `AllProvidersFailedError`.
- `threshold` must be a positive integer and **cannot exceed the number of
  configured providers** — `new ExchangeRatePicker({ providers, threshold: 6 })`
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
treated as quoting USDT — but new providers should use `getPriceInNgn`.

Drop it anywhere in the `providers` array and the averaging, breaker, cache,
and events apply to it automatically.

## Error handling

```ts
import { AllProvidersFailedError } from "cngn-rate-picker";

try {
  const rate = await picker.getUsdtToNgn();
} catch (err) {
  if (err instanceof AllProvidersFailedError) {
    // err.errors is a ProviderError[] — one entry per provider that failed
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

Contributions are welcome — new providers, bug fixes, docs, and test coverage
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
├── index.ts       # public API barrel — every export goes through here
├── picker.ts      # ExchangeRatePicker: TWAP averaging, cache, circuit breaker
├── types.ts       # shared contracts (Rate, RateProvider, ProviderQuote)
├── errors.ts      # ProviderError, AllProvidersFailedError
├── http.ts        # httpJson + toPrice helpers used by all providers
└── providers/     # one file per upstream API adapter
test/              # node:test suites (no network — use fake providers)
examples/          # runnable usage examples
```

### Adding a provider

This is the most common contribution. The checklist:

1. Create `src/providers/<name>.ts` implementing `RateProvider` — one class,
   one `getPriceInNgn(ctx)` method, plus an `asset` field (or an `asset`
   option) saying which stablecoin it quotes. Use `httpJson` and `toPrice`
   from `../http.js` rather than calling `fetch` directly, so the injected
   fetch, timeout signal, and price validation apply automatically.
2. Make the base URL a constructor parameter with a default (see
   `QuidaxProvider`) so tests can point it at a mock.
3. Export the class (and any options type) from `src/index.ts`.
4. Add tests in `test/`. Tests must not hit the network — inject a fake
   `fetch` via the picker options or call the provider with a stubbed
   `ProviderContext`.
5. Document it in the "Built-in providers" table above, including the rate
   type (market vs official) and any reliability caveats. Unofficial or
   undocumented endpoints must be clearly flagged as such.

Remember the one canonical rule: providers report a single number — **NGN per
1 unit of their declared asset** — as a finite, positive value, and throw on
any failure. The picker handles everything else (asset matching, retries,
TWAP averaging, caching, inversion).

### Pull request guidelines

- Before opening a PR, make sure all three pass locally:
  `npm run typecheck`, `npm test`, and `npm run build`.
- Keep PRs focused — one provider or one fix per PR is much easier to review
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
and — if a provider is involved — the raw upstream payload if you have it
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
money. This project is not affiliated with Quidax, CoinGecko, Blockradar, or
any rate provider.

## License

MIT
