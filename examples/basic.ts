import {
  ExchangeRatePicker,
  QuidaxProvider,
  CoinGeckoProvider,
  ExchangeRateApiProvider,
} from "../src/index.js";

// Providers are tried in order. Quidax first (real market rate),
// CoinGecko next (independent market source), the official USD/NGN last
// as a "never fully fail" fallback.
const picker = new ExchangeRatePicker({
  providers: [
    new QuidaxProvider(),
    new CoinGeckoProvider(),
    new ExchangeRateApiProvider(),
  ],
  timeoutMs: 4000,
  cacheTtlMs: 15_000,
  onProviderError: (e) => console.warn("provider failed:", e.message),
});

const usdtToNgn = await picker.getUsdtToNgn();
console.log(`1 USDT = ${usdtToNgn.rate.toFixed(2)} NGN (via ${usdtToNgn.provider})`);

const fifty = await picker.convert(50_000, "NGN", "USDT");
console.log(`50,000 NGN = ${fifty.amount.toFixed(2)} USDT (via ${fifty.rate.provider})`);
