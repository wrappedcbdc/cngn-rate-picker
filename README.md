# naira-rate-picker

Resilient **NGN ⇄ USDT** exchange-rate library for TypeScript. Query multiple
rate providers behind one interface; if the first fails, it automatically fails
over to the next. Zero runtime dependencies, works in Node 18+ and modern
browsers.

```ts
import {
  ExchangeRatePicker,
  QuidaxProvider,
  CoinGeckoProvider,
  ExchangeRateApiProvider,
} from "naira-rate-picker";

const picker = new ExchangeRatePicker({
  providers: [
    new QuidaxProvider(),        // primary: real Nigerian market rate
    new CoinGeckoProvider(),     // fallback: independent market source
    new ExchangeRateApiProvider(), // last resort: official USD/NGN proxy
  ],
  timeoutMs: 4000,
  cacheTtlMs: 15_000,
});

const r = await picker.getUsdtToNgn();
console.log(`1 USDT = ${r.rate} NGN (via ${r.provider})`);

const { amount } = await picker.convert(50_000, "NGN", "USDT");
console.log(`50,000 NGN = ${amount.toFixed(2)} USDT`);
```

## Install

```bash
npm install naira-rate-picker
```

## Why the design looks like this

The library composes three classic patterns, each doing one job:

| Pattern | Where | What it buys you |
| --- | --- | --- |
| **Strategy** | `RateProvider` interface | Providers are interchangeable. Add, remove, or reorder them without touching the picker. |
| **Adapter** | each `*Provider` class | Each upstream API has a different response shape; the adapter normalises it to one `ProviderQuote` (`NGN per USDT`). |
| **Chain of Responsibility** | `ExchangeRatePicker` | The picker walks the provider list and returns the first success — this *is* the failover. |

On top of that the picker adds a **circuit breaker** (skip a provider that keeps
failing, retry it after a cooldown), a per-provider **timeout**, and an optional
**TTL cache**. It acts as a **facade**: callers only see `getUsdtToNgn()`,
`getNgnToUsdt()`, and `convert()`.

Everything canonicalises to a single number — *NGN per 1 USDT* — so providers
stay tiny and both conversion directions are derived in one place.

## Built-in providers

| Provider | Source | Rate type | Key? |
| --- | --- | --- | --- |
| `QuidaxProvider` | Quidax USDT/NGN ticker | Live crypto **market** rate | No |
| `CoinGeckoProvider` | CoinGecko simple price | Aggregated market rate | No |
| `ExchangeRateApiProvider` | open.er-api.com USD→NGN | **Official** rate (USDT≈USD proxy) | No |
| `BinanceP2PProvider` | Binance P2P (unofficial) | P2P market rate | No |

> **Choose your ordering deliberately.** In Nigeria the *official* rate can sit
> well below the *crypto/parallel* rate. Put a market source (Quidax/CoinGecko)
> first and use the official rate only as a graceful-degradation fallback, or
> your numbers will silently drift from the street rate.

> `BinanceP2PProvider` is **unofficial and unsupported** — Binance delisted all
> NGN spot pairs in March 2024, so it scrapes an undocumented P2P endpoint that
> can rate-limit or break without notice. Not registered by default; opt in only
> if you accept that fragility.

## Options

```ts
new ExchangeRatePicker({
  providers,                 // required, in priority order
  timeoutMs: 5000,           // per-provider timeout
  cacheTtlMs: 0,             // 0 = no cache
  circuitBreaker: {          // or `false` to disable
    failureThreshold: 3,     // consecutive failures before skipping
    cooldownMs: 30_000,      // how long to skip before a retry
  },
  fetch: globalThis.fetch,   // inject a custom fetch (proxy, mock, metrics)
  onProviderError: (e) => {},
  onSuccess: (rate) => {},
});
```

## Writing your own provider

Implement one method. That's the whole contract.

```ts
import { RateProvider, ProviderContext, ProviderQuote, httpJson, toPrice } from "naira-rate-picker";

export class MyExchangeProvider implements RateProvider {
  readonly name = "my-exchange";

  async getUsdtPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    const body = await httpJson<{ price: string }>(
      "https://api.my-exchange.com/usdt-ngn",
      { ctx }, // ctx carries the injected fetch + timeout signal
    );
    return { price: toPrice(body.price), raw: body };
  }
}
```

Drop it anywhere in the `providers` array and the failover, breaker, cache, and
events apply to it automatically.

## Error handling

```ts
import { AllProvidersFailedError } from "naira-rate-picker";

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
git clone <your-fork-url>
cd naira-rate-picker
npm install        # dev dependencies only (typescript, tsx)
npm test           # everything should be green before you start
```

### Project layout

```
src/
├── index.ts       # public API barrel — every export goes through here
├── picker.ts      # ExchangeRatePicker: failover, cache, circuit breaker
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
   one `getUsdtPriceInNgn(ctx)` method. Use `httpJson` and `toPrice` from
   `../http.js` rather than calling `fetch` directly, so the injected fetch,
   timeout signal, and price validation apply automatically.
2. Make the base URL a constructor parameter with a default (see
   `QuidaxProvider`) so tests can point it at a mock.
3. Export the class (and any options type) from `src/index.ts`.
4. Add tests in `test/`. Tests must not hit the network — inject a fake
   `fetch` via the picker options or call the provider with a stubbed
   `ProviderContext`.
5. Document it in the "Built-in providers" table above, including the rate
   type (market vs official) and any reliability caveats. Unofficial or
   undocumented endpoints must be clearly flagged, like `BinanceP2PProvider`.

Remember the one canonical rule: providers report a single number — **NGN per
1 USDT** — as a finite, positive value, and throw on any failure. The picker
handles everything else (retries, failover, caching, inversion).

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
- If you're changing the public API or the failover semantics, open an issue
  first so the design can be discussed before you invest the time.

### Reporting bugs

Open an issue with the library version, Node version, a minimal reproduction,
and — if a provider is involved — the raw upstream payload if you have it
(`Rate.raw` is kept for exactly this). Please **do not** include API keys or
account details in issues.

## Disclaimer

Rates are sourced from third-party public endpoints and provided as-is for
informational purposes. Verify against your settlement source before moving
money. This project is not affiliated with Quidax, Binance, CoinGecko, or any
rate provider.

## License

MIT
