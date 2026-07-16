import {
  ExchangeRatePicker,
  CoinGeckoProvider,
  ExchangeRateApiProvider, QuidaxProvider,
} from "../src/index.js";

// One picker = one market. Set `asset` and use providers configured for it —
// the picker refuses mismatched providers at construction time.
const picker = new ExchangeRatePicker({
  asset: "USDC",
  providers: [
    new CoinGeckoProvider({ asset: "USDC" }), // usd-coin in NGN
    new ExchangeRateApiProvider(), // fiat-USD proxy — matches any USD stablecoin
    new QuidaxProvider({ asset: "USDC" })
    // market — as of July 2026 it only lists cngnusdt.
  ],
  threshold: 2,
  parallel: true,
  timeoutMs: 4000,
  onProviderError: (e) => console.warn("provider failed:", e.message),
});

const usdcToNgn = await picker.getStablecoinToNgn();
console.log(`1 USDC = ${usdcToNgn.rate.toFixed(2)} NGN`);
for (const source of usdcToNgn.sources) {
  const marker = source.usedInAverage ? "*" : " ";
  console.log(`  ${marker} ${source.provider}: ${source.price}`);
}

const fifty = await picker.convert(50_000, "NGN", "USDC");
console.log(`50,000 NGN = ${fifty.amount.toFixed(2)} USDC`);

// When the next USD stablecoin gets a market, no library update is needed:
// new ExchangeRatePicker({
//   asset: "PYUSD",
//   providers: [
//     new CoinGeckoProvider({ asset: "PYUSD", coinId: "paypal-usd" }),
//     new ExchangeRateApiProvider(),
//   ],
// });
