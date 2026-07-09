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

## Disclaimer

Rates are sourced from third-party public endpoints and provided as-is for
informational purposes. Verify against your settlement source before moving
money. This project is not affiliated with Quidax, Binance, CoinGecko, or any
rate provider.

## License

MIT
