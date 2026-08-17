import {
  ExchangeRatePicker,
  QuidaxProvider,
  CoinGeckoProvider,
  ExchangeRateApiProvider, BybitP2PProvider, TextileProvider, BlockradarProvider, MexcProvider,
} from "../src/index.js";

const picker = new ExchangeRatePicker({
  providers: [
    new QuidaxProvider(),
    new TextileProvider(),
    new BybitP2PProvider(),
    new MexcProvider(),
    new CoinGeckoProvider(),
    new ExchangeRateApiProvider()
  ],
  threshold: 3,
  parallel: true,
  timeoutMs: 4000,
  onProviderError: (e) => console.warn("provider failed:", e.message),
});

const usdtToNgn = await picker.getUsdtToNgn();
console.log(`1 USDT = ${usdtToNgn.rate.toFixed(2)} NGN`);
for (const source of usdtToNgn.sources) {
  const marker = source.usedInAverage ? "*" : " ";
  console.log(`  ${marker} ${source.provider}: ${source.price}`);
}
console.log("(* = contributed to the averaged rate above)");
const fifty = await picker.convert(50_000, "NGN", "USDT");
console.log(`50,000 NGN = ${fifty.amount.toFixed(2)} USDT`);
