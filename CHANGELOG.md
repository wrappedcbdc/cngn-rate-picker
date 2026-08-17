# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Providers now quote a TWAP instead of a spot price** wherever the upstream
  exposes a time series. Thin NGN corridors let a single print or a momentarily
  skewed book distort a spot quote far more than the real clearing level, and
  the picker would average that into a settlement rate.
  - `QuidaxProvider` averages the public kline series
    (`/markets/{market}/k`), weighting each candle's close by how long it
    stood. New options: `price` (`"twap"` default, `"spot"` for the previous
    ticker behaviour), `twapWindowMs` (default 1 h), `klinePeriodMinutes`
    (default 1), `maxStalenessMs` (default 6 h, `false` disables) and `invert`.
  - `CoinGeckoProvider` averages `/coins/{id}/market_chart` (5-minute
    granularity), falling back to `/simple/price` on an empty window. New
    options: `price`, `twapWindowMs`, `twapFallback`.
- `QuidaxProvider` **rejects a stale kline series** rather than quoting it.
  As of 2026-08-17 the reversed `cngnusdt` market has not traded in ~6 months
  (every candle zero-volume, its ticker still reporting ~1477 against ~1394 on
  live venues) and `cngnusdc` serves an empty series, while the default
  `usdtcngn` is fresh at ~1395. Set `maxStalenessMs: false` to restore the old
  behaviour of quoting whatever the market last reported.
- `QuidaxProvider` infers whether a market needs inverting from its id: one
  starting with the asset symbol (`usdtngn`) is read as NGN per asset, anything
  else (`cngnusdt`) as asset per cNGN. Previously inversion was unconditional,
  so a `market` override in the other direction returned a reciprocal price.
  `invert` overrides the inference.
- `BlockradarProvider` now quotes the public `/assets/rates` feed by default
  instead of `/rates/market-benchmark`. It queries both directions for the
  configured asset (`cNGN→<asset>` and `<asset>→cNGN`) in parallel, normalises
  each to USD per cNGN, averages the ones that succeeded, and inverts to this
  library's NGN-per-asset contract, so a single broken direction degrades the
  quote rather than failing it. `price: "benchmark"` restores the previous
  competing-Liquidity-Provider figure, and `allRoutes: true` blends the other
  stablecoin's routes into the same average. Route layout and normalisation
  follow the reference implementation in
  [lavavc/simple-mm](https://github.com/lavavc/simple-mm/blob/main/engine/venues/wallet/blockradar.py).
- Provider errors now name the underlying network failure. `fetch` rejects with
  a bare "fetch failed" and buries the reason in `cause`, which made a DNS
  block indistinguishable from any other outage; failures now read as
  `ENOTFOUND for api2.bybit.com: host did not resolve (DNS) ...`. Applies to
  every provider that goes through `httpJson`.

### Added

- `BybitP2PProvider` can call the **documented** P2P API. Passing `apiKey` +
  `apiSecret` switches it from the keyless `api2.bybit.com` web endpoint to
  [`POST /v5/p2p/item/online`](https://bybit-exchange.github.io/docs/p2p/ad/online-ad-list),
  signed per the
  [P2P auth spec](https://bybit-exchange.github.io/docs/p2p/guide)
  (HMAC-SHA256 over `timestamp + apiKey + recvWindow + body`, sent as `X-BAPI-*`
  headers) using Web Crypto, so no new dependency and no Node-only API. Bybit
  restricts the P2P API to General Advertiser accounts or above. New options:
  `apiKey`, `apiSecret`, `recvWindowMs`, `hosts`.
- `BybitP2PProvider` tries each documented host in turn
  (`api.bybit.com`, then the `api.bytick.com` alias) and only fails when every
  host does, which is what makes it usable on networks that block `bybit.com`
  at the resolver. The keyless endpoint has no documented alias, so it stays
  single-host.
- `MexcProvider`, spot market rate from MEXC. Quotes a **TWAP of kline closes**
  by default (`klineInterval`, default `"1m"`; `twapWindowMs`, default 1 hour;
  `maxStalenessMs`, default 6 hours) and reads the documented ticker endpoints
  for spot modes: `price: "last"` uses
  [`/api/v3/ticker/price`](https://www.mexc.com/api-docs/spot-v3/market-data-endpoints/symbol-price-ticker)
  and `"mid"`/`"bid"`/`"ask"` use
  [`/api/v3/ticker/bookTicker`](https://www.mexc.com/api-docs/spot-v3/market-data-endpoints/symbol-order-book-ticker),
  which also serve as the empty-window fallback (`twapFallback`, default
  `"mid"`). Symbols are built from `asset` + `quote` (default `"NGN"`) or set
  via `symbol`, with the inversion direction inferred from the symbol and
  `invert` as an override. MEXC's `{"code":-1121,"msg":"invalid symbol"}` bodies
  are surfaced verbatim instead of being flattened to an HTTP status.
  **Caveat:** MEXC lists no NGN or cNGN pair as of 2026-08-17 (0 of 2102 spot
  symbols), so the default `USDTNGN` symbol fails over until one is listed.
- `describeFetchFailure` and `fetchOrDescribe` (`src/http.ts`), exported for
  custom providers that call `fetch` directly.
- `timeWeightedAverage`, `withinWindow`, `newestPoint` and the `PricePoint`
  type (`src/twap.ts`), exported so custom providers weight prices exactly as
  the built-ins do: each observation weighted by how long it stood as the most
  recent one, newest weighted up to now, equal timestamps clamped to 1 ms so
  none drops out. Distinct from the picker's cross-provider TWAP; the two
  compose.
- `BybitP2PProvider`: parallel/street rate from Bybit P2P advertisements
  with fraud filtering: per side, ads are kept only from reputable online
  traders (≥100 completed orders, ≥90% completion rate, release time ≤900),
  prices beyond 2% of the median are rejected, and the modal whole-NGN price
  is taken; the quote is the buy/sell mid. Thresholds are configurable
  (`BybitP2PProviderOptions`), and `asset` selects the P2P token (default
  `"USDT"`). Uses the undocumented `api2.bybit.com` endpoint that backs
  Bybit's P2P web UI. That path is best-effort by nature, so pair it with other
  providers.
- `TextileProvider`: rate from the public
  [Textile Credit FX feed](https://fx-docs.textilecredit.com/api/rates.html)
  (no API key). Defaults to the `<asset>_NGN` corridor (cNGN is published as
  `NGN`, pegged 1:1) and quotes a **TWAP of cleared trades** from
  `GET /historical_trades`: both sides are merged and each trade is weighted by
  how long it stood as the last cleared price, so a single large print or a
  momentarily skewed book can't move the rate much. `twapWindowMs` sets the
  lookback (default 1 hour) and `twapLimit` the trades requested per side
  (default 200, capped at the feed's 1000). An empty window falls back to the
  order book's bid/ask mid (`twapFallback`, default `"mid"`; `false` throws so
  another provider supplies the rate). `price` reads `GET /tickers` directly
  instead (`"mid"`, `"last"`, `"bid"`, or `"ask"`), and
  `asset`/`tickerId`/`baseUrl` are configurable (`TextileProviderOptions`).

### Fixed

- `BybitP2PProvider` read `recentExecuteRate` as a fraction, but Bybit reports
  it as a percentage on some responses ("98"). The `minCompletionRate: 0.9`
  filter therefore passed every trader, including ones at 50% completion.
  Values above 1 are now read as percentages.
- `BybitP2PProvider` coerced a missing `avgReleaseTime` to `0`, reading "field
  absent" as "instant release" and silently passing the release-time filter.
  The documented endpoint does not return that field at all, so it is now
  treated as unknown and the criterion is skipped.

## [0.2.0] - 2026-07-16

### Added

- **USDC support and stablecoin extensibility.** `ExchangeRatePicker` takes an
  `asset` option (default `"USDT"`). One picker = one market: the picker
  trades exactly one USD-backed stablecoin against NGN, so the TWAP never
  mixes quotes for different coins. Any symbol is accepted (`"PYUSD"`,
  `"FDUSD"`, …); future stablecoins need no library update.
- `getStablecoinToNgn()` / `getNgnToStablecoin()`: asset-agnostic facade
  methods that quote whatever the picker is configured for.
- `picker.asset`: public readonly access to the configured symbol.
- `RateProvider.asset`: providers declare which asset they quote. A concrete
  symbol only matches a picker configured for that symbol; `"USD"` marks a
  fiat-USD proxy (e.g. an official FX rate) accepted by every picker.
  Mismatches throw at construction time, so a USDC quote can never silently
  poison a USDT average.
- `QuidaxProvider` accepts `{ asset, market, baseUrl }`. The market id
  defaults to `cngn<asset-lowercased>` (e.g. `cngnusdc`), with `market` as an
  explicit override. Note: as of July 2026 Quidax lists `cngnusdt` but not
  `cngnusdc`.
- `CoinGeckoProvider` accepts `{ asset, coinId, baseUrl }`. USDT (`tether`)
  and USDC (`usd-coin`) ids are built in; other assets require an explicit
  `coinId` and throw a helpful error without one.
- `BlockradarProvider` accepts an `asset` option, benchmarked as
  `fromAsset=<asset>&toAsset=cNGN`.
- `ExchangeRateApiProvider` declares `asset: "USD"`, so the official USD→NGN
  rate can back a picker for any USD stablecoin.
- New exported types: `UsdStablecoin`, `ProviderAsset`, `AnyRateProvider`,
  `LegacyRateProvider`, `QuidaxProviderOptions`, `CoinGeckoProviderOptions`.
- `examples/usdc.ts`: runnable USDC picker example.

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

- `BlockradarProvider`: Blockradar market-benchmark rate for `USDT/cNGN`
  (requires an API key).
- `threshold` and `parallel` options on `ExchangeRatePicker` for combining
  several providers into one time-weighted average (TWAP) rate.
- `Rate.sources` (`RateSource[]`): every queried provider's individual
  quote, each tagged with `usedInAverage`.
- `ThresholdNotMetError`, thrown when fewer than `threshold` providers
  succeed.

### Changed

- Renamed the package from `naira-rate-picker` to `cngn-rate-picker`.
- `QuidaxProvider` now reads the `cNGN/USDT` market (previously `USDT/NGN`),
  matching Quidax's current endpoint and response shape.
- `ExchangeRatePicker` now queries **every** configured provider on every
  call; there's no early exit. The first `threshold` successes (in
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
