# Upbit and Bithumb KRW spot

Public REST discovery, tickers and top-of-book snapshots are integrated with native `KRW-TOKEN` symbols. Search `TOKEN`, `TOKEN-KRW` or `KRW-TOKEN`; aliases resolve to the token symbol without inventing listings. Only KRW rows returned by each exchange's current market catalog are selectable. Each market retains its exchange/native symbol and identity confirmation remains required.

To add coverage to an existing project, edit it, refresh matching markets, select verified Upbit/Bithumb spot pairs and save after signing in. Existing selections are never changed automatically. Projects retain the existing primary USDT perpetual requirement; KRW spot cannot be the derivatives analytics primary. The global derivatives venue selector stays scoped to the existing perpetual venues.

Selected KRW spots display in Market Overview and Cross-Exchange Analysis. New read-only route: `GET /api/projects/:id/korean-spot`. The research-context export has a separate `koreanSpot` section. All KRW data is separate from normalized USDT/USD price, volume, contribution, regime and CVD aggregation; no undocumented FX conversion or Korean-premium calculation is performed. These sources do not have OI, funding, futures liquidations or verified USDT aggressor flow.

Price, 24-hour volume/turnover and bid/ask remain in native units. `signed_change_rate` represents change from the venue's previous close, not a rolling 24-hour price return. The bid/ask REST snapshot is not sequence-verified full L2 depth. Missing/stale/crossed books are unavailable, independently of a successful ticker. Source timestamps are validated separately from fetch time. Missing or future source times produce partial quality and an explicit timestamp issue; raw source time is retained. No speculative timezone offset is applied.

Catalog cache: 30 minutes; ticker/book cache: 10 seconds; browser refresh: 30 seconds while viewed. Fixed allowlisted origins, 10-second request timeout, bounded queues/caches, request deduplication, per-venue 200ms dispatch spacing and shared 60-second cooldown on 429. REST only; historical KRW candles, on-chain identity mapping, live trades, KRW CVD and historical storage are not implemented by this increment.

Live verification returned 299 Upbit and 489 Bithumb KRW markets, and real `KRW-BTC` prices, rolling turnover and book snapshots for both. The current directories did not return `KRW-JCT`; a JCT pair is not assumed listed. One Bithumb ticker response carried a future timestamp; it correctly remained partial instead of fabricating a current source time. Counts and listings can change.

Official endpoints/docs:

- https://docs.upbit.com/kr/reference/list-trading-pairs
- https://docs.upbit.com/kr/reference/list-tickers
- https://docs.upbit.com/kr/reference/list-orderbooks
- https://apidocs.bithumb.com/reference/거래-대상-목록-조회
- https://apidocs.bithumb.com/reference/현재가-조회
- https://apidocs.bithumb.com/reference/호가-조회

