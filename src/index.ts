// Core
export { ExchangeRatePicker } from "./picker.js";
export type { RatePickerOptions, CircuitBreakerOptions } from "./picker.js";

// Contracts
export type {
  CurrencyCode,
  Rate,
  ProviderQuote,
  ProviderContext,
  RateProvider,
} from "./types.js";

// Errors
export { ProviderError, AllProvidersFailedError } from "./errors.js";

// Helpers for writing custom providers
export { httpJson, toPrice } from "./http.js";
export type { HttpJsonOptions } from "./http.js";

// Built-in providers
export { QuidaxProvider } from "./providers/quidax.js";
export { CoinGeckoProvider } from "./providers/coingecko.js";
export { ExchangeRateApiProvider } from "./providers/exchangeRateApi.js";
export { BinanceP2PProvider } from "./providers/binanceP2P.js";
export type { BinanceP2POptions } from "./providers/binanceP2P.js";
