# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-16

### Added

- **USDC support and stablecoin extensibility.** `ExchangeRatePicker` takes an
  `asset` option (default `"USDT"`). One picker = one market: the picker
  trades exactly one USD-backed stablecoin against NGN, so the TWAP never
  mixes quotes for different coins. Any symbol is accepted (`"PYUSD"`,
  `"FDUSD"`, …) — future stablecoins need no library update.
- `getStablecoinToNgn()` / `getNgnToStablecoin()` — asset-agnostic facade
  methods that quote whatever the picker is configured for.
- `picker.asset` — public readonly access to the configured symbol.
- `RateProvider.asset` — providers declare which asset they quote. A concrete
  symbol only matches a picker configured for that symbol; `"USD"` marks a
  fiat-USD proxy (e.g. an official FX rate) accepted by every picker.
  Mismatches throw at construction time, so a USDC quote can never silently
  poison a USDT average.
- `QuidaxProvider` accepts `{ asset, market, baseUrl }` — the market id
  defaults to `cngn<asset-lowercased>` (e.g. `cngnusdc`), with `market` as an
  explicit override. Note: as of July 2026 Quidax lists `cngnusdt` but not
  `cngnusdc`.
- `CoinGeckoProvider` accepts `{ asset, coinId, baseUrl }` — USDT (`tether`)
  and USDC (`usd-coin`) ids are built in; other assets require an explicit
  `coinId` and throw a helpful error without one.
- `BlockradarProvider` accepts an `asset` option, benchmarked as
  `fromAsset=<asset>&toAsset=cNGN`.
- `ExchangeRateApiProvider` declares `asset: "USD"`, so the official USD→NGN
  rate can back a picker for any USD stablecoin.
- New exported types: `UsdStablecoin`, `ProviderAsset`, `AnyRateProvider`,
  `LegacyRateProvider`, `QuidaxProviderOptions`, `CoinGeckoProviderOptions`.
- `examples/usdc.ts` — runnable USDC picker example.

### Changed

- The provider contract method is now `getPriceInNgn(ctx)`. Custom providers
  implementing only the old `getUsdtPriceInNgn(ctx)` are still accepted and
  treated as quoting USDT; the built-in providers keep a deprecated
  `getUsdtPriceInNgn` alias. New code should implement `getPriceInNgn`.
- `getUsdtToNgn()` / `getNgnToUsdt()` now throw with a clear message on a
  picker whose `asset` isn't `"USDT"`, instead of mislabelling another coin's
  rate.
- `getRate()` / `convert()` validate currency codes against the picker's
  configured pair (`asset` ⇄ `NGN`) and throw on anything else.
- `QuidaxProvider` and `CoinGeckoProvider` constructors take an options
  object; the old bare-`baseUrl`-string signature still works.

## [0.1.1]

### Added

- `BlockradarProvider` — Blockradar market-benchmark rate for `USDT/cNGN`
  (requires an API key).
- `threshold` and `parallel` options on `ExchangeRatePicker` for combining
  several providers into one time-weighted average (TWAP) rate.
- `Rate.sources` (`RateSource[]`) — every queried provider's individual
  quote, each tagged with `usedInAverage`.
- `ThresholdNotMetError`, thrown when fewer than `threshold` providers
  succeed.

### Changed

- Renamed the package from `naira-rate-picker` to `cngn-rate-picker`.
- `QuidaxProvider` now reads the `cNGN/USDT` market (previously `USDT/NGN`),
  matching Quidax's current endpoint and response shape.
- `ExchangeRatePicker` now queries **every** configured provider on every
  call — there's no early exit. The first `threshold` successes (in
  provider-priority order) are combined into `rate.rate` via TWAP instead of
  simply returning the first success.

### Removed

- `BinanceP2PProvider` (unofficial/unsupported Binance P2P scraping).

### Fixed

- The `example` npm script pointed at a nonexistent `example/` directory
  instead of `examples/`.
- Missing `@types/node` dev dependency caused TypeScript errors in the test
  suite.

## [0.1.0]

Initial release: `ExchangeRatePicker` with `QuidaxProvider`,
`CoinGeckoProvider`, `ExchangeRateApiProvider`, and `BinanceP2PProvider`,
circuit breaker, per-provider timeout, and TTL cache.

[0.2.0]: https://github.com/wrappedcbdc/cngn-rate-picker/releases/tag/v0.2.0
[0.1.1]: https://github.com/wrappedcbdc/cngn-rate-picker/releases/tag/v0.1.1
[0.1.0]: https://github.com/wrappedcbdc/cngn-rate-picker/releases/tag/v0.1.0
