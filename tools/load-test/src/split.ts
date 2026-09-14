/**
 * split.ts — divide a step's global populations across workers. Per-game and
 * lobby counts spread as evenly as possible (remainder to the first workers);
 * per-game values (spectatorsPerGame) go to every worker unchanged; single-game
 * work (spectatorsOnFirst) goes to worker 0 alone.
 */

import type { Populations } from './directives.js';

/** `total` split into `workers` whole parts, largest first. */
export function shares(total: number, workers: number): number[] {
  const base = Math.floor(total / workers);
  const extra = total % workers;
  return Array.from({ length: workers }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Per-worker populations for a step's global targets. */
export function splitPopulations(pop: Populations, workers: number): Populations[] {
  const wire = shares(pop.wireGames ?? 0, workers);
  const sim = shares(pop.simGames ?? 0, workers);
  const idlers = shares(pop.idlers ?? 0, workers);
  const rooms = shares(pop.rooms ?? 0, workers);
  const churners = shares(pop.churners ?? 0, workers);
  return Array.from({ length: workers }, (_, i) => ({
    wireGames: wire[i]!,
    simGames: sim[i]!,
    idlers: idlers[i]!,
    rooms: rooms[i]!,
    churners: churners[i]!,
    // Per-game: the same for every worker.
    spectatorsPerGame: pop.spectatorsPerGame ?? 0,
    // Single-game: worker 0 only.
    spectatorsOnFirst: i === 0 ? (pop.spectatorsOnFirst ?? 0) : 0,
  }));
}
