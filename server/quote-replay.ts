import { STRENGTH_WINDOW_MS, type StrengthPoint } from '../shared/strength-history.ts';

const MAX_CLOCK_SKEW_MS = 5_000;
const BUCKET_COUNT = Math.ceil((STRENGTH_WINDOW_MS + MAX_CLOCK_SKEW_MS) / 1000) + 1;

/** Bounded, event-time buckets. A quiet market has no samples for its missing seconds. */
export class QuoteReplay {
  private buckets = new Array<StrengthPoint | undefined>(BUCKET_COUNT);

  record(price: number, at: number, now: number) {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(at) || at <= 0 ||
        at < now - STRENGTH_WINDOW_MS || at > now + MAX_CLOCK_SKEW_MS) return;
    const slot = Math.floor(at / 1000) % BUCKET_COUNT;
    const previous = this.buckets[slot];
    if (!previous || at >= previous.t) this.buckets[slot] = { t: at, p: price };
  }

  window(now: number) {
    return this.buckets
      .filter((point): point is StrengthPoint => !!point && point.t >= now - STRENGTH_WINDOW_MS && point.t <= now)
      .sort((first, second) => first.t - second.t);
  }
}
