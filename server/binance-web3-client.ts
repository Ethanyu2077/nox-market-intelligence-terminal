import { createHmac, randomUUID } from "node:crypto";

const ROUTES: Record<string, "GET" | "POST"> = {
  "/api/v1/dex/market/token/advanced-info": "GET",
  "/api/v1/dex/market/supported/chain": "GET",
  "/api/v1/dex/market/price-info": "POST",
  "/api/v1/dex/market/candles": "GET",
  "/api/v1/dex/market/token/top-liquidity": "GET",
  "/api/v1/defi/data/investment/list": "POST",
};
export function signWeb3(
  secret: string,
  timestamp: string,
  method: string,
  requestPath: string,
  body = "",
) {
  if (!requestPath.startsWith("/build/api/v1/"))
    throw new Error("Signed path must include /build");
  return createHmac("sha256", secret)
    .update(timestamp + method + requestPath + body, "utf8")
    .digest("base64");
}
export class Web3Error extends Error {
  constructor(public code: string) {
    super(code);
  }
}
type Envelope = {
  code: number;
  success?: boolean;
  data: unknown;
  timestamp?: number;
};
export class BinanceWeb3Client {
  private cache = new Map<
    string,
    {
      until: number;
      value: { data: unknown; timestamp: number | null; fetchedAt: number };
    }
  >();
  private pending = new Map<
    string,
    Promise<{ data: unknown; timestamp: number | null; fetchedAt: number }>
  >();
  private gate = Promise.resolve();
  private cooldown = 0;
  constructor(
    private key = process.env.BINANCE_WEB3_API_KEY ?? "",
    private secret = process.env.BINANCE_WEB3_SECRET_KEY ?? "",
    private transport: typeof fetch = fetch,
  ) {}
  get configured() {
    return !!this.key && !!this.secret;
  }
  async request(
    path: string,
    params: Record<string, unknown> | unknown[],
    ttl = 30_000,
  ) {
    const method = ROUTES[path];
    if (!method) throw new Web3Error("endpoint-not-allowed");
    if (!this.configured) throw new Web3Error("not-configured");
    const body = method === "POST" ? JSON.stringify(params) : "";
    const query =
      method === "GET"
        ? Object.entries(params)
            .map(
              ([k, v]) =>
                `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
            )
            .join("&")
        : "";
    const requestPath = "/build" + path + (query ? "?" + query : "");
    const cacheKey = method + requestPath + body;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.until > Date.now()) return cached.value;
    const inFlight = this.pending.get(cacheKey);
    if (inFlight) return inFlight;
    if (this.pending.size >= 40) throw new Web3Error('request-queue-full');
    const task = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const slot = this.gate.then(async () => {
          if (this.cooldown > Date.now()) throw new Web3Error("rate-limited");
          await new Promise((resolve) => setTimeout(resolve, 250));
        });
        this.gate = slot.catch(() => {});
        await slot;
        const timestamp = new Date().toISOString();
        let response: Response;
        try {
          response = await this.transport(
            "https://web3.binance.com" + requestPath,
            {
              method,
              redirect: "error",
              signal: AbortSignal.timeout(10_000),
              headers: {
                "Content-Type": "application/json",
                "X-OC-APIKEY": this.key,
                "X-OC-TIMESTAMP": timestamp,
                "X-OC-SIGN": signWeb3(
                  this.secret,
                  timestamp,
                  method,
                  requestPath,
                  body,
                ),
                "X-OC-NONCE": randomUUID(),
              },
              ...(method === "POST" ? { body } : {}),
            },
          );
        } catch {
          throw new Web3Error("network-unavailable");
        }
        if (response.status === 429) {
          const raw = response.headers.get("Retry-After");
          const seconds = raw != null ? Number(raw) : NaN;
          this.cooldown =
            Date.now() +
            (Number.isFinite(seconds) ? Math.max(1, seconds) * 1000 : 60_000);
          throw new Web3Error("rate-limited");
        }
        if (response.status >= 500 && attempt === 0) continue;
        if (!response.ok)
          throw new Web3Error(
            response.status === 401
              ? "authentication-failed"
              : response.status === 403
                ? "permission-or-region-restricted"
                : `http-${response.status}`,
          );
        let value: Envelope;
        try {
          value = (await response.json()) as Envelope;
        } catch {
          throw new Web3Error("invalid-response");
        }
        if (value.code !== 0 || value.success === false) {
          if (value.code === 42900) {
            this.cooldown = Date.now() + 60_000;
            throw new Web3Error("rate-limited");
          }
          throw new Web3Error(
            value.code === 40101 || value.code === 40102 || value.code === 40103
              ? "authentication-failed"
              : value.code === 40104
                ? "permission-or-region-restricted"
                : "upstream-rejected",
          );
        }
        const result = {
          data: value.data,
          timestamp:
            typeof value.timestamp === "number" &&
            Number.isFinite(value.timestamp)
              ? value.timestamp
              : null,
          fetchedAt: Date.now(),
        };
        if (this.cache.size >= 300)
          this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(cacheKey, { until: Date.now() + ttl, value: result });
        return result;
      }
      throw new Web3Error("upstream-unavailable");
    })();
    this.pending.set(cacheKey, task);
    try {
      return await task;
    } finally {
      this.pending.delete(cacheKey);
    }
  }
}
