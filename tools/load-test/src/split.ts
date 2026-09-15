/**
 * split.ts — divide a step's global populations across workers, and time how
 * long its new bots take to arrive. Per-game and lobby counts spread as evenly
 * as possible (remainder to the first workers); per-game values
 * (spectatorsPerGame) go to every worker unchanged; single-game work
 * (spectatorsOnFirst) goes to worker 0 alone. A field the step leaves out stays
 * out, so each worker keeps its current target for it.
 */

import type { ArrivalRates, Populations } from './directives.js';

/** `total` split into `workers` whole parts, largest first. */
export function shares(total: number, workers: number): number[] {
  const base = Math.floor(total / workers);
  const extra = total % workers;
  return Array.from({ length: workers }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Populations counted per bot, spread across the workers. */
const SPREAD = ['wireGames', 'simGames', 'idlers', 'rooms', 'churners'] as const;

/** Per-worker populations for a step's global targets. */
export function splitPopulations(pop: Populations, workers: number): Populations[] {
  const parts: Populations[] = Array.from({ length: workers }, () => ({}));
  for (const key of SPREAD) {
    const total = pop[key];
    if (total === undefined) continue;
    shares(total, workers).forEach((n, i) => (parts[i]![key] = n));
  }
  const perGame = pop.spectatorsPerGame;
  // Per-game: the same for every worker.
  if (perGame !== undefined) for (const part of parts) part.spectatorsPerGame = perGame;
  const onFirst = pop.spectatorsOnFirst;
  // Single-game: worker 0 only.
  if (onFirst !== undefined)
    parts.forEach((part, i) => (part.spectatorsOnFirst = i === 0 ? onFirst : 0));
  return parts;
}

const games = (p: Required<Populations>): number => p.wireGames + p.simGames;
const spectators = (p: Required<Populations>): number =>
  games(p) * p.spectatorsPerGame + (games(p) > 0 ? p.spectatorsOnFirst : 0);

/**
 * How long, in ms, the bots a step adds take to arrive at `rates` (global, per
 * second): the slowest population's growth over its rate, since populations
 * arrive side by side. Populations that shrink leave at once.
 */
export function arrivalMs(
  from: Required<Populations>,
  to: Required<Populations>,
  rates: ArrivalRates,
): number {
  const secs = (before: number, after: number, rate: number): number =>
    after > before && rate > 0 ? (after - before) / rate : 0;
  return (
    1000 *
    Math.max(
      secs(games(from), games(to), rates.games),
      secs(spectators(from), spectators(to), rates.spectators),
      secs(from.idlers, to.idlers, rates.idlers),
      secs(from.rooms, to.rooms, rates.rooms),
      secs(from.churners, to.churners, rates.churners),
    )
  );
}
