/**
 * histogram.ts — a fixed-bucket latency histogram. Bucket counts add, so the
 * histograms of several worker processes merge exactly, and memory stays
 * constant however many samples arrive. Values are milliseconds, kept to the
 * microsecond: below 64 µs every bucket is 1 µs wide, above that there are 32
 * buckets per power of two, so a reported percentile is within about 3% of
 * the true value. The maximum is kept exactly.
 */

const SUB_BITS = 5;
const SUB = 1 << SUB_BITS;
/** Largest value bucketed, in µs (about 35 minutes); larger values land in the top bucket. */
const MAX_US = 0x7fffffff;

function bucketOf(us: number): number {
  if (us < 2 * SUB) return us;
  const shift = 31 - Math.clz32(us) - SUB_BITS;
  return shift * SUB + (us >>> shift);
}

/** The middle of bucket `i`, in µs. */
function bucketMid(i: number): number {
  if (i < 2 * SUB) return i;
  const shift = Math.floor(i / SUB) - 1;
  const width = 2 ** shift;
  return (i - shift * SUB) * width + (width - 1) / 2;
}

const BUCKETS = bucketOf(MAX_US) + 1;

/** A histogram as plain data, to cross a process boundary: `[bucket, count]` pairs. */
export interface HistogramData {
  buckets: [number, number][];
  count: number;
  sum: number;
  max: number;
}

export class Histogram {
  private readonly counts = new Float64Array(BUCKETS);
  count = 0;
  sum = 0;
  max = 0;

  static from(data: HistogramData): Histogram {
    const h = new Histogram();
    h.merge(data);
    return h;
  }

  record(ms: number): void {
    const v = ms > 0 ? ms : 0; // negatives (clock skew) and NaN count as 0
    this.counts[bucketOf(Math.min(MAX_US, Math.round(v * 1000)))]!++;
    this.count++;
    this.sum += v;
    if (v > this.max) this.max = v;
  }

  /** The `p`th percentile (0..100) in ms; NaN when empty. */
  percentile(p: number): number {
    if (this.count === 0) return NaN;
    const rank = Math.max(1, Math.ceil((p / 100) * this.count));
    let seen = 0;
    for (let i = 0; i < BUCKETS; i++) {
      seen += this.counts[i]!;
      if (seen >= rank) return Math.min(this.max, bucketMid(i) / 1000);
    }
    return this.max;
  }

  get mean(): number {
    return this.count === 0 ? NaN : this.sum / this.count;
  }

  merge(other: Histogram | HistogramData): void {
    const data = other instanceof Histogram ? other.toData() : other;
    for (const [i, n] of data.buckets) this.counts[i]! += n;
    this.count += data.count;
    this.sum += data.sum;
    this.max = Math.max(this.max, data.max);
  }

  toData(): HistogramData {
    const buckets: [number, number][] = [];
    for (let i = 0; i < BUCKETS; i++) if (this.counts[i]! > 0) buckets.push([i, this.counts[i]!]);
    return { buckets, count: this.count, sum: this.sum, max: this.max };
  }

  reset(): void {
    this.counts.fill(0);
    this.count = 0;
    this.sum = 0;
    this.max = 0;
  }
}
