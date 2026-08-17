import type { ProviderContext, ProviderQuote, RateProvider, UsdStablecoin } from "../types.js";
import { describeFetchFailure, toPrice } from "../http.js";

interface BybitP2PItem {
  price: string | number;
  recentOrderNum?: string | number;
  recentExecuteRate?: string | number;
  avgReleaseTime?: string | number;
  isOnline?: boolean;
}

interface BybitP2PResponse {
  /** The official endpoint uses snake_case here; the web endpoint omits it. */
  ret_code?: number;
  ret_msg?: string;
  retCode?: number;
  retMsg?: string;
  result?: {
    count?: number;
    items?: BybitP2PItem[];
  };
}

interface P2PAd {
  price: number;
  completedOrders: number;
  /** Fraction in [0, 1]; normalised from whichever convention the host uses. */
  completionRate: number;
  /** Seconds, or null when the endpoint doesn't report it. */
  avgReleaseTime: number | null;
  isOnline: boolean;
}

/**
 * Documented mainnet hosts, tried in order. Bybit lists `api.bytick.com` as an
 * equivalent alias, which matters because some networks and resolvers block
 * `bybit.com` outright while leaving `bytick.com` reachable.
 */
const OFFICIAL_HOSTS = ["https://api.bybit.com", "https://api.bytick.com"];
/** The endpoint behind Bybit's own P2P web UI. Keyless, undocumented, no alias. */
const WEB_HOSTS = ["https://api2.bybit.com"];
/** `size` ceiling documented for the official endpoint. */
const MAX_PAGE_SIZE = 300;

export interface BybitP2PProviderOptions {
  /** Token traded against NGN on Bybit P2P (default "USDT"). */
  asset?: UsdStablecoin;
  /**
   * Bybit API key. Supplying `apiKey` + `apiSecret` switches this provider to
   * the **documented** `POST /v5/p2p/item/online` endpoint; without them it
   * uses the keyless endpoint behind Bybit's P2P web UI.
   *
   * Note Bybit restricts the P2P API to accounts with General Advertiser
   * status or above, so keys from an ordinary account will be rejected.
   *
   * @see https://bybit-exchange.github.io/docs/p2p/guide
   */
  apiKey?: string;
  /** Bybit API secret, used to sign requests (HMAC-SHA256). */
  apiSecret?: string;
  /** `X-BAPI-RECV-WINDOW` in milliseconds (default 5000). */
  recvWindowMs?: number;
  /** Ads from traders with fewer completed orders are ignored (default 100). */
  minCompletedOrders?: number;
  /** Ads from traders below this completion rate are ignored (default 0.90). */
  minCompletionRate?: number;
  /** Ads from traders with a slower average release time are ignored (default 900). */
  maxAvgReleaseTime?: number;
  /** Ads priced further than this fraction from the median are ignored (default 0.02). */
  maxDeviationFromMedian?: number;
  /** Ads fetched per side (default 50, capped at 300 on the official endpoint). */
  pageSize?: number;
  /** Single host override. Takes precedence over the built-in host list. */
  baseUrl?: string;
  /** Hosts to try in order, first reachable one wins. */
  hosts?: string[];
}

/**
 * USDT/NGN street rate from Bybit P2P advertisements, with fraud filtering.
 *
 * Per side (buy ads → ask, sell ads → bid):
 * 1. keep only reputable ads (completed orders, completion rate, release
 *    time, online) — fewer than 3 survivors means no quote;
 * 2. drop ads further than `maxDeviationFromMedian` from the median price;
 * 3. take the mode — the most frequently listed whole-NGN price.
 *
 * The returned price is the bid/ask mid.
 *
 * Two transports are supported. With `apiKey` + `apiSecret` it calls the
 * documented `POST /v5/p2p/item/online`, which Bybit restricts to General
 * Advertiser accounts. Without credentials it calls `api2.bybit.com`, the
 * keyless endpoint behind Bybit's own P2P web UI — not a documented public
 * API, so treat that path as best-effort and back it with other providers.
 *
 * @see https://bybit-exchange.github.io/docs/p2p/ad/online-ad-list
 */
export class BybitP2PProvider implements RateProvider {
  readonly name = "bybit-p2p";
  readonly asset: UsdStablecoin;
  private readonly apiKey?: string;
  private readonly apiSecret?: string;
  private readonly recvWindowMs: number;
  private readonly minCompletedOrders: number;
  private readonly minCompletionRate: number;
  private readonly maxAvgReleaseTime: number;
  private readonly maxDeviationFromMedian: number;
  private readonly pageSize: number;
  private readonly hosts: string[];
  /** True when calling the documented, signed endpoint. */
  private readonly official: boolean;

  constructor(options: BybitP2PProviderOptions = {}) {
    this.asset = options.asset ?? "USDT";
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.official = Boolean(options.apiKey && options.apiSecret);
    if (Boolean(options.apiKey) !== Boolean(options.apiSecret)) {
      throw new Error(
        "BybitP2PProvider needs both apiKey and apiSecret to use the documented P2P API, or neither to use the keyless endpoint",
      );
    }
    this.recvWindowMs = options.recvWindowMs ?? 5000;
    this.minCompletedOrders = options.minCompletedOrders ?? 100;
    this.minCompletionRate = options.minCompletionRate ?? 0.9;
    this.maxAvgReleaseTime = options.maxAvgReleaseTime ?? 900;
    this.maxDeviationFromMedian = options.maxDeviationFromMedian ?? 0.02;
    this.pageSize = Math.min(options.pageSize ?? 50, MAX_PAGE_SIZE);
    this.hosts = options.baseUrl
      ? [options.baseUrl]
      : (options.hosts ?? (this.official ? OFFICIAL_HOSTS : WEB_HOSTS));
    if (this.hosts.length === 0) throw new Error("BybitP2PProvider needs at least one host");
  }

  async getPriceInNgn(ctx: ProviderContext): Promise<ProviderQuote> {
    const [buy, sell] = await Promise.all([
      this.fetchAds(ctx, "buy"),
      this.fetchAds(ctx, "sell"),
    ]);

    const ask = this.filterAndAggregate(buy.ads, "buy");
    const bid = this.filterAndAggregate(sell.ads, "sell");
    return { price: (bid + ask) / 2, raw: { buy: buy.raw, sell: sell.raw } };
  }

  private async fetchAds(
    ctx: ProviderContext,
    side: "buy" | "sell",
  ): Promise<{ ads: P2PAd[]; raw: BybitP2PResponse }> {
    const body = await this.post(ctx, side);
    const code = body.ret_code ?? body.retCode;
    if (code !== undefined && code !== 0) {
      throw new Error(
        `Bybit P2P returned ${code}: ${body.ret_msg ?? body.retMsg ?? "no message"} (${side})`,
      );
    }

    const items = body?.result?.items ?? [];
    const ads = items.map((item) => ({
      price: toPrice(item.price),
      completedOrders: Number(item.recentOrderNum ?? 0),
      completionRate: normaliseRate(item.recentExecuteRate),
      // The documented endpoint doesn't return a release time; null means
      // "unknown" so the filter skips that criterion rather than treating a
      // missing value as instant release.
      avgReleaseTime: item.avgReleaseTime === undefined ? null : Number(item.avgReleaseTime),
      isOnline: item.isOnline ?? false,
    }));
    return { ads, raw: body };
  }

  /** POSTs to the first reachable host, signing the request when configured. */
  private async post(ctx: ProviderContext, side: "buy" | "sell"): Promise<BybitP2PResponse> {
    const path = this.official ? "/v5/p2p/item/online" : "/fiat/otc/item/online";
    const payload = this.official
      ? // Documented parameters. The docs define "0" as buy and "1" as sell,
        // the inverse of the web endpoint's encoding — harmless either way
        // here, since swapping the sides leaves the bid/ask mid unchanged.
        JSON.stringify({
          tokenId: this.asset,
          currencyId: "NGN",
          side: side === "buy" ? "0" : "1",
          page: "1",
          size: String(this.pageSize),
        })
      : JSON.stringify({
          tokenId: this.asset,
          currencyId: "NGN",
          side: side === "buy" ? "1" : "0",
          size: String(this.pageSize),
          page: "1",
          payment: [],
          amount: "",
        });

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.official) Object.assign(headers, await this.signedHeaders(payload));

    const failures: string[] = [];
    for (const host of this.hosts) {
      const url = `${host}${path}`;
      let res: Response;
      try {
        res = await ctx.fetch(url, {
          method: "POST",
          headers,
          body: payload,
          signal: ctx.signal,
        });
      } catch (err) {
        // Network-level failure (DNS, refused, TLS): the next host may work,
        // since Bybit's hosts are documented aliases for the same API.
        failures.push(describeFetchFailure(err, url));
        continue;
      }
      if (!res.ok) {
        failures.push(`HTTP ${res.status} ${res.statusText} from ${url}`);
        continue;
      }
      return (await res.json()) as BybitP2PResponse;
    }

    throw new Error(
      `Bybit P2P unreachable on ${this.hosts.length === 1 ? "its host" : `all ${this.hosts.length} hosts`} (${side}): ${failures.join("; ")}`,
    );
  }

  /** Bybit V5 auth: HMAC-SHA256 over timestamp + apiKey + recvWindow + body. */
  private async signedHeaders(payload: string): Promise<Record<string, string>> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      throw new Error(
        "signing Bybit P2P requests needs Web Crypto (globalThis.crypto.subtle), which this runtime does not provide",
      );
    }
    const timestamp = String(Date.now());
    const recvWindow = String(this.recvWindowMs);
    const encoder = new TextEncoder();
    const key = await subtle.importKey(
      "raw",
      encoder.encode(this.apiSecret!),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await subtle.sign(
      "HMAC",
      key,
      encoder.encode(timestamp + this.apiKey! + recvWindow + payload),
    );
    const sign = Array.from(new Uint8Array(mac))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return {
      "X-BAPI-API-KEY": this.apiKey!,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": sign,
    };
  }

  private filterAndAggregate(ads: P2PAd[], side: "buy" | "sell"): number {
    const reputable = ads.filter(
      (ad) =>
        ad.completedOrders >= this.minCompletedOrders &&
        ad.completionRate >= this.minCompletionRate &&
        (ad.avgReleaseTime === null || ad.avgReleaseTime <= this.maxAvgReleaseTime) &&
        ad.isOnline,
    );
    if (reputable.length < 3) {
      throw new Error(
        `fewer than 3 reputable Bybit P2P ${side} ads after fraud filtering (${reputable.length})`,
      );
    }

    const prices = reputable.map((ad) => ad.price).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)]!;
    let filtered = reputable.filter(
      (ad) => Math.abs(ad.price - median) / median <= this.maxDeviationFromMedian,
    );
    if (filtered.length < 2) filtered = reputable;

    // Mode: round to whole NGN to cluster equivalent prices; ties go to the
    // price seen first, matching listing order.
    const counts = new Map<number, number>();
    for (const ad of filtered) {
      const ngn = Math.round(ad.price);
      counts.set(ngn, (counts.get(ngn) ?? 0) + 1);
    }
    let modeNgn = 0;
    let best = 0;
    for (const [ngn, count] of counts) {
      if (count > best) {
        modeNgn = ngn;
        best = count;
      }
    }
    return modeNgn;
  }
}

/**
 * Completion rate as a fraction. Bybit reports this as a percentage on some
 * responses ("98") and a fraction on others ("0.98"); anything above 1 is read
 * as a percentage, so the reputability filter means the same thing either way.
 */
function normaliseRate(value: string | number | undefined): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1 ? n / 100 : n;
}
