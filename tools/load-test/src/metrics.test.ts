import { describe, expect, it } from 'vitest';
import { Aggregate, Metrics } from './metrics.js';

describe('Metrics', () => {
  it('take() returns everything since the last take and resets counters', () => {
    const m = new Metrics();
    m.count('errors', 3);
    m.hist.forward.record(5);
    m.httpStatus('submit', 200);
    m.httpStatus('submit', 200);

    const first = m.take();
    expect(first.counters.errors).toBe(3);
    expect(first.http['submit 200']).toBe(2);
    expect(first.hist.forward.count).toBe(1);

    const second = m.take();
    expect(second.counters.errors).toBe(0);
    expect(second.http).toEqual({});
    expect(second.hist.forward.count).toBe(0);
  });

  it('times a room-list push once per session per batch of unseen lobby events', () => {
    const m = new Metrics();
    m.lobbyEvent(1000);
    m.lobbyEvent(1010);
    // One push covers both events (timed from the older).
    let seen = m.pushReceived(0, 1025);
    expect(seen).toBe(2);
    // A list with nothing new since isn't a push of anything.
    seen = m.pushReceived(seen, 1030);
    m.lobbyEvent(1040);
    seen = m.pushReceived(seen, 1045);
    expect(seen).toBe(3);

    const taken = m.take();
    expect(taken.hist.push.count).toBe(2);
    expect(taken.counters.lobbyEvents).toBe(3);
  });
});

describe('Aggregate', () => {
  it('sums counters and http across workers and keeps the latest gauges', () => {
    const agg = new Aggregate();
    const worker = (errors: number, games: number) => {
      const m = new Metrics();
      m.count('errors', errors);
      m.httpStatus('scores', 429);
      return {
        ...m.take(),
        gauges: {
          games,
          playing: games,
          simGames: 0,
          spectators: 0,
          idlers: 0,
          rooms: 0,
          churners: 0,
          abusers: 0,
          sockets: games * 2,
        },
        peaks: { genLoopP99: 1, genLoopMax: 2, genCpuPct: 10 },
        games: [] as string[],
      };
    };
    agg.addInterval([worker(2, 5), worker(3, 7)], 10);
    expect(agg.counters.errors).toBe(5);
    expect(agg.http['scores 429']).toBe(2);
    expect(agg.gauges.games).toBe(12);
    expect(agg.rate('errors')).toBeCloseTo(0.5, 6);
  });

  it('takes the worst worker for peaks', () => {
    const agg = new Aggregate();
    const mk = (p99: number) => {
      const m = new Metrics();
      return {
        ...m.take(),
        gauges: {
          games: 0,
          playing: 0,
          simGames: 0,
          spectators: 0,
          idlers: 0,
          rooms: 0,
          churners: 0,
          abusers: 0,
          sockets: 0,
        },
        peaks: { genLoopP99: p99, genLoopMax: p99 * 2, genCpuPct: p99 },
        games: [] as string[],
      };
    };
    agg.addInterval([mk(3), mk(7), mk(1)], 10);
    expect(agg.peaks.genLoopP99).toBe(7);
    expect(agg.peaks.genLoopMax).toBe(14);
  });
});
