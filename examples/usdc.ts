import {
  ExchangeRatePicker,
  QuidaxProvider,
  BybitP2PProvider,
  TextileProvider,
} from "../src/index.js";

// One picker = one market. Set `asset` and use providers configured for it:
// the picker refuses mismatched providers at construction time.
const picker = new ExchangeRatePicker({
  asset: "USDC",
  providers: [
    new TextileProvider({ asset: "USDC" }), // USDC_NGN corridor, TWAP of cleared trades
    new QuidaxProvider({ asset: "USDC" }), // usdccngn market, if listed
    new BybitP2PProvider({ asset: "USDC" }), // USDC/NGN P2P street rate
  ],
  // USDC has thinner cNGN coverage than USDT, so require only one success
  // rather than a quorum.
  threshold: 1,
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
//     new TextileProvider({ asset: "PYUSD" }),
//     new QuidaxProvider({ asset: "PYUSD", market: "pyusdcngn" }),
//   ],
// });
