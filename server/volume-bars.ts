import type { OrderFlowResponse } from '../shared/orderflow.ts';
import type { VolumeBarAggregate, VolumeBarBucket, VolumeBarVenue, VolumeBarsResponse } from '../shared/volume.ts';

/** Map orderflow's completed bucket contract to event-time volume bars (USDT-only tape). */
export function buildVolumeBars(projectId: string, snapshot: OrderFlowResponse, now = Date.now()): VolumeBarsResponse {
  const mapBucket = (bucket: OrderFlowResponse['venues'][number]['buckets'][number]): VolumeBarBucket => ({
    time: bucket.time,
    // Volume requires both sides to be known; a partially covered bucket stays null.
    volumeUsd: bucket.buy != null && bucket.sell != null ? bucket.buy + bucket.sell : null,
    buyUsd: bucket.buy,
    sellUsd: bucket.sell,
    base: bucket.base,
    buyBase: bucket.buyBase,
    sellBase: bucket.sellBase,
    vwap: bucket.vwap,
    high: bucket.high,
    low: bucket.low,
    maxTradeNotional: bucket.maxTradeNotional,
    trades: bucket.count,
    complete: bucket.complete,
  });
  const venues: VolumeBarVenue[] = snapshot.venues
    // KRW spot is not collected as a USDT tape; it is displayed in the separate KRW block.
    .filter((venue) => venue.market.quote === 'USDT')
    .map((venue) => {
      const buckets = venue.buckets.map(mapBucket);
      return {
        key: venue.key,
        exchange: venue.market.exchange,
        marketType: venue.market.marketType,
        symbol: venue.market.symbol,
        quote: venue.market.quote,
        state: venue.state,
        transport: venue.transport,
        coverageFrom: venue.coverageFrom,
        coverageTo: venue.coverageTo,
        lastTradeAt: venue.lastTradeAt,
        gaps: venue.gaps.length,
        retainedTrades: venue.retainedTrades,
        buckets,
        completeBuckets: buckets.filter((bucket) => bucket.complete).length,
        observedBuckets: buckets.filter((bucket) => bucket.trades > 0).length,
      };
    });
  const aggregate = (type: 'spot' | 'perpetual'): VolumeBarAggregate => {
    const buckets = snapshot.aggregates[type].buckets.map(mapBucket);
    return { buckets, completeBuckets: buckets.filter((bucket) => bucket.complete).length, observedBuckets: buckets.filter((bucket) => bucket.trades > 0).length };
  };
  return {
    projectId,
    generatedAt: now,
    interval: snapshot.interval,
    asOf: snapshot.generatedAt ?? now,
    venues,
    aggregates: { spot: aggregate('spot'), perpetual: aggregate('perpetual') },
    methodology: [
      'Event-time buckets come from the locally collected trade tape (orderflow service), not from 24h rolling venue counters.',
      'A bucket is complete only when the tape covers its whole interval; null volume means partial coverage, not zero.',
      'USDT-quoted markets only; KRW spot is excluded here and shown in the separate KRW block.',
      'REST backfill and WebSocket overlap are bounded; first/last buckets are partial and gaps are explicit per venue.',
      'This is observed trade tape, not aggressive-flow sign decomposition; buy/sell here are the venue-side taker fields mapped by the orderflow adapters.',
      'Base quantity is normalized by contract multipliers before aggregation; notional is quote currency (USDT for this tape).',
      'VWAP is base-weighted inside the bucket; partially covered buckets are observed-trade VWAP, not a complete-window VWAP.',
    ],
  };
}
