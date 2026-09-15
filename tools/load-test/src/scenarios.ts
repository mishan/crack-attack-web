/**
 * scenarios.ts — the plan's scenarios (docs/LOAD_TEST_PLAN.md, L1–L12) as
 * data: each a list of steps the coordinator plays. A step sets global target
 * populations (divided across workers), optional churn/scoreboard/abuse, and
 * timed one-shot actions, then holds so the numbers settle before a reading.
 *
 * Counts here are global; the coordinator splits per-game and lobby counts
 * across workers, keeps per-game values (spectatorsPerGame) the same for all,
 * and sends single-game work (spectatorsOnFirst, the burst/storm actions) to
 * worker 0 only. Scenarios that centre on one game force a single worker.
 */

import type {
  AbuseSpec,
  ArrivalRates,
  ChurnConfig,
  Populations,
  ScoreboardConfig,
} from './directives.js';

/** A one-shot during a step, `atMs` into its hold. */
export type ScenarioAction =
  | { atMs: number; type: 'reconnectStorm'; fraction: number; spreadMs: number }
  | { atMs: number; type: 'endStorm' }
  | { atMs: number; type: 'lateJoinBurst'; count: number }
  | { atMs: number; type: 'slowReaders'; count: number; ms: number }
  | { atMs: number; type: 'reconnectSome'; fraction: number }
  | { atMs: number; type: 'scoreBurst' };

export interface ScenarioStep {
  label: string;
  /** Global target populations after this step (see file header on splitting). */
  populations?: Populations;
  churn?: ChurnConfig | null;
  scoreboard?: ScoreboardConfig | null;
  abuse?: AbuseSpec[];
  /**
   * Time before the reading hold. Default: until the step's new bots have
   * arrived at the scenario's rates, plus the run's settle time.
   */
  rampMs?: number;
  /** Reading hold, as planned. Default {@link DEFAULT_HOLD_MS}; `--hold` overrides every step. */
  holdMs?: number;
  actions?: ScenarioAction[];
}

export interface Scenario {
  name: string;
  description: string;
  /** Centres on one game/first-game: the coordinator runs it in one worker. */
  singleWorker?: boolean;
  /** Marked in the plan to also be run behind nginx (informational). */
  nginx?: boolean;
  /** Arrival rates, where the plan's defaults (`DEFAULT_ARRIVALS`) don't fit. */
  arrivals?: Partial<ArrivalRates>;
  /** Wire games report a result and rematch this often (the CLI's `--rotate` overrides). */
  rotateMs?: number;
  steps: ScenarioStep[];
}

export interface ScenarioOptions {
  /** Keep only the first N steps (quick runs). */
  maxSteps?: number | undefined;
}

/** The plan's hold per step: two minutes. */
export const DEFAULT_HOLD_MS = 120_000;

const MINUTE = 60_000;
const GAME_STEPS = [10, 50, 100, 250, 500, 1000, 2000];
const SPECTATOR_STEPS = [10, 50, 100, 250, 500, 1000, 2000];

/** A ramp of steps over `counts`, each setting `populations(count)`. */
function ramp(
  counts: number[],
  label: (n: number) => string,
  populations: (n: number) => Populations,
): ScenarioStep[] {
  return counts.map((n) => ({ label: label(n), populations: populations(n) }));
}

/** Baseline scoreboard "ceiling" traffic (plan L11). */
const CEILING_SCOREBOARD: ScoreboardConfig = {
  ticketsPerSec: 5,
  submitsPerSec: 3,
  scoresPerSec: 20,
  replaysPerSec: 2,
  submitKinds: ['advance', 'ai'],
  aiTicks: 9_000,
  clientCount: 8,
};

function build(options: ScenarioOptions): Record<string, Scenario> {
  const scenarios: Record<string, Scenario> = {
    l1: {
      name: 'l1',
      description: 'Baseline: one wire-bot game, no spectators, 5 minutes.',
      singleWorker: true,
      steps: [{ label: '1game', populations: { wireGames: 1 }, holdMs: 5 * MINUTE }],
    },
    l2: {
      name: 'l2',
      description: 'Idle sessions: room-list push cost and RSS per session.',
      steps: [
        ...ramp(
          [500, 1000, 2500, 5000, 10000],
          (n) => `${n}idlers`,
          (n) => ({ idlers: n }),
        ),
        // One room appears: a single room-list push to every idler.
        { label: 'push', populations: { rooms: 1 }, holdMs: 30_000 },
      ],
    },
    l3: {
      name: 'l3',
      description: 'Concurrent games, no spectators (1 in 20 a sim pair).',
      nginx: true,
      steps: ramp(
        GAME_STEPS,
        (n) => `${n}games`,
        (n) => ({
          wireGames: n - Math.floor(n / 20),
          simGames: Math.floor(n / 20),
        }),
      ),
    },
    l4a: {
      name: 'l4a',
      description: 'Spectators on one game.',
      singleWorker: true,
      steps: ramp(
        SPECTATOR_STEPS,
        (n) => `${n}spec`,
        (n) => ({
          wireGames: 1,
          spectatorsOnFirst: n,
        }),
      ),
    },
    l4b: {
      name: 'l4b',
      description: 'Spectators spread over 50 games.',
      steps: ramp(
        [2, 5, 10, 20, 50],
        (n) => `50x${n}`,
        (n) => ({
          wireGames: 50,
          spectatorsPerGame: n,
        }),
      ),
    },
    l5a: {
      name: 'l5a',
      description: 'A 30-minute game, then 100 spectators join in a second.',
      singleWorker: true,
      steps: [
        {
          label: '30min+100join',
          populations: { wireGames: 1 },
          holdMs: 30 * MINUTE,
          actions: [{ atMs: 30 * MINUTE - 30_000, type: 'lateJoinBurst', count: 100 }],
        },
      ],
    },
    l5b: {
      name: 'l5b',
      description: 'A 60-minute game, then 100 spectators join in a second.',
      singleWorker: true,
      steps: [
        {
          label: '60min+100join',
          populations: { wireGames: 1 },
          holdMs: 60 * MINUTE,
          actions: [{ atMs: 60 * MINUTE - 30_000, type: 'lateJoinBurst', count: 100 }],
        },
      ],
    },
    l6: {
      name: 'l6',
      description: 'Lobby churn: idlers × open rooms × event rate, games alongside.',
      steps: [
        {
          label: 'S2000_R200_5/s',
          populations: { idlers: 2000, rooms: 200, churners: 10, wireGames: 50 },
          churn: { mode: 'rooms', ratePerSec: 5 },
        },
        {
          label: 'S5000_R500_20/s',
          populations: { idlers: 5000, rooms: 500, churners: 20, wireGames: 50 },
          churn: { mode: 'rooms', ratePerSec: 20 },
        },
      ],
    },
    l7: {
      name: 'l7',
      description: 'Slow readers: 5 of 20 spectators stop reading, then permanently.',
      singleWorker: true,
      steps: [
        {
          label: '20spec_5slow',
          populations: { wireGames: 1, spectatorsOnFirst: 20 },
          holdMs: 180_000,
          actions: [
            { atMs: 30_000, type: 'slowReaders', count: 5, ms: 60_000 },
            { atMs: 120_000, type: 'slowReaders', count: 5, ms: -1 },
          ],
        },
      ],
    },
    l8: {
      name: 'l8',
      description: 'Reconnect storm: 200 games, cut and rejoin all at once, then spread.',
      steps: [
        {
          label: 'storm_5s',
          populations: { wireGames: 200 },
          holdMs: 120_000,
          actions: [{ atMs: 30_000, type: 'reconnectStorm', fraction: 1, spreadMs: 5_000 }],
        },
        {
          // Spread past the 30 s grace, so about a quarter come back too late
          // and forfeit.
          label: 'storm_40s',
          populations: { wireGames: 200 },
          holdMs: 120_000,
          actions: [{ atMs: 30_000, type: 'reconnectStorm', fraction: 1, spreadMs: 40_000 }],
        },
      ],
    },
    l9: {
      name: 'l9',
      description: 'Match-end storm: 500 games all report a result in one second.',
      steps: [
        {
          label: '500end',
          populations: { wireGames: 500 },
          holdMs: 60_000,
          actions: [{ atMs: 20_000, type: 'endStorm' }],
        },
      ],
    },
    l10: {
      name: 'l10',
      description: 'Abusive WebSocket clients alongside 50 games.',
      steps: [
        {
          label: 'abuse',
          populations: { wireGames: 50 },
          abuse: [
            { kind: 'silent', count: 500 },
            { kind: 'churn', count: 500, rate: 100 },
            { kind: 'bigframes', count: 50 },
            { kind: 'malformed', count: 50, rate: 1000 },
            { kind: 'flood', count: 50 },
          ],
        },
      ],
    },
    l11: {
      name: 'l11',
      description: 'Scoreboard at its ceiling alongside 50 games.',
      steps: [
        { label: 'ceiling', populations: { wireGames: 50 }, scoreboard: CEILING_SCOREBOARD },
        {
          // 64 hard-AI runs submitted within one second. The ramp gathers them
          // (tickets at the ceiling rate, each played into a replay) and outlasts
          // the server's pacing floor — a run can't be submitted sooner than it
          // could have been played, about 3 minutes here — then the burst fires.
          label: 'verifier_saturation',
          populations: { wireGames: 50 },
          scoreboard: { ...CEILING_SCOREBOARD, submitsPerSec: 0, submitKinds: ['ai'], prefill: 64 },
          rampMs: 4 * MINUTE,
          actions: [{ atMs: 10_000, type: 'scoreBurst' }],
        },
        {
          label: 'padded_flood',
          populations: { wireGames: 50 },
          scoreboard: { ...CEILING_SCOREBOARD, submitsPerSec: 5, submitKinds: ['padded'] },
          holdMs: 30 * MINUTE,
        },
      ],
    },
    l12: {
      name: 'l12',
      description: 'Soak at the operating point for an hour.',
      // Every game ends and re-readies every 10 minutes.
      rotateMs: 10 * MINUTE,
      steps: [
        {
          label: 'soak',
          populations: {
            wireGames: 250,
            simGames: 5,
            spectatorsPerGame: 2,
            idlers: 500,
            churners: 1,
          },
          churn: { mode: 'rooms', ratePerSec: 1 },
          scoreboard: CEILING_SCOREBOARD,
          holdMs: 60 * MINUTE,
          actions: [
            // 10% of players reconnect once, a third of the way in.
            { atMs: 20 * MINUTE, type: 'reconnectSome', fraction: 0.1 },
          ],
        },
      ],
    },
  };
  // Apply the max-steps cap.
  if (options.maxSteps !== undefined) {
    for (const s of Object.values(scenarios)) s.steps = s.steps.slice(0, options.maxSteps);
  }
  return scenarios;
}

/** All scenarios. */
export function scenarioTable(options: ScenarioOptions = {}): Record<string, Scenario> {
  return build(options);
}

/** A scenario by name, or undefined. */
export function getScenario(name: string, options: ScenarioOptions = {}): Scenario | undefined {
  return build(options)[name.toLowerCase()];
}

export const SCENARIO_NAMES = [
  'l1',
  'l2',
  'l3',
  'l4a',
  'l4b',
  'l5a',
  'l5b',
  'l6',
  'l7',
  'l8',
  'l9',
  'l10',
  'l11',
  'l12',
] as const;
