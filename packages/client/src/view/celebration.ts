/**
 * celebration.ts — the end-of-match win/loss celebration, ported from
 * `CelebrationManager.{h,cxx}` + the draw math in `DrawMessages.cxx`.
 *
 * When a game ends the board dims out and the result message performs: a WIN
 * scales in from huge (×12) while fading, then strobes; a LOSS message drops
 * from above and bounces to rest under gravity/drag with decaying elasticity.
 * This is pure, DOM-free animation logic (like `view/loseBar.ts`); the render
 * layer applies the returned transforms to the message overlay and dims the
 * board. The driver still chooses *which* message (winner / loser / game over).
 *
 * A WIN also throws fireworks: five spark "sources" whose emission rate
 * sputters (decays, with random boosts) — this module runs that rate algorithm
 * and emits per-tick spawn requests ({@link drainSparkSpawns}); the render layer
 * turns them into real sparks (`Sparkles.createCelebrationSpark`).
 *
 * Divergence: the exact win-message tint is not ported (the flash is a white
 * brightness pulse over the white message), and the spark source positions are
 * placed around our single board rather than the reference's two-board layout.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

// Display constants from Displayer.h (celebration section). Ticks are 50 Hz.
const CELEBRATION_FADE_TIME = 200;
const CELEBRATION_TIME = 225;
const WIN_FADE_TIME = 50;
const STARTING_WIN_SCALE = 12;
const WIN_FLASH_1_TIME = 8;
const WIN_FLASH_2_TIME = 12;
const WIN_FLASH_1_CHANCE_IN = 3;
const WIN_FLASH_2_CHANCE_IN = 6;
const STARTING_LOSS_HEIGHT = 18; // 9 * DC_GRID_ELEMENT_LENGTH (2)
const STARTING_BOUNCE_COUNT = 6;
const FINAL_BOUNCE_COUNT = 2;
const LOSS_GRAVITY = 0.01;
const LOSS_DRAG = 0.005;
const LOSS_MIN_VELOCITY = 10 * LOSS_GRAVITY;
const LOSS_BOUNCE_ELASTICITY = 0.5;
const LOSS_END_BOUNCE_ELASTICITY = 0.1;

// Celebration spark ("firework") rate algorithm (Displayer.h + CelebrationManager).
const CSPARK_SOURCE_NUMBER = 5;
const CSPARK_COLOR_NUMBER = 5;
const CSPARK_STARTING_RATE = 270;
const CSPARK_FULL_RATE = 600;
const CSPARK_LOW_RATE = 150;
const CSPARK_QUICK_RATE_DROP = 3;
const CSPARK_BOOST_CHANCE_IN = 40;
const CSPARK_RATE_BOOST = 90;
const CSPARK_COLOR_CHANGE_CHANCE_IN = 5;

export type CelebrationOutcome = 'win' | 'loss';

/** A request to launch one firework spark from `source` (0..4) in `color` (0..4). */
export interface CelebrationSparkSpawn {
  readonly source: number;
  readonly color: number;
}

/** What the render layer needs to draw the celebration for a frame. */
export interface CelebrationView {
  /** How dark the board should be, 0..1 (1 = black). = 1 - light_level. */
  readonly boardDim: number;
  /** Result-message opacity, 0..1. */
  readonly opacity: number;
  /** Result-message scale multiplier (win scales 12→1; loss stays 1). */
  readonly scale: number;
  /**
   * Fraction of the loss drop still remaining, 0..1: 1 = fully raised at the top
   * (start), 0 = landed at rest (centre). The render layer translates the
   * message *up* from centre by this fraction (it falls as the value shrinks,
   * bouncing back up on each rebound). Always 0 for a win.
   */
  readonly dropFraction: number;
  /** Extra brightness pulse, 0..1 (win strobes). */
  readonly flash: number;
  /**
   * True once the fixed celebration timer (CELEBRATION_TIME) elapses — the point
   * the reference lets the user dismiss the celebration (MetaState::
   * celebrationComplete). It is a wall-clock timer, *not* tied to the loss
   * bounce having physically settled (which may still be in progress).
   */
  readonly complete: boolean;
}

/** The random draws the celebration needs (cosmetic — never gameplay). */
export interface CelebrationRng {
  /** 1-in-`n` chance. */
  chanceIn(n: number): boolean;
  /** Integer in [0, n). */
  number(n: number): number;
}

const defaultRng: CelebrationRng = {
  chanceIn: (n) => Math.floor(Math.random() * n) === 0,
  number: (n) => Math.floor(Math.random() * n),
};

/**
 * The celebration animation. Call {@link start} with the outcome at match end,
 * then {@link tick} once per sim tick; read {@link view} each frame.
 */
export class Celebration {
  private t = 0;
  private outcome: CelebrationOutcome = 'loss';
  private running = false;

  private lightLevel = 1;
  private done = false;

  // win state
  private winAlpha = 0;
  private winScale = STARTING_WIN_SCALE;
  private winFlash1 = 0;
  private winFlash2 = 0;

  // loss state
  private lossHeight = STARTING_LOSS_HEIGHT;
  private lossVelocity = 0;
  private lossBounce = STARTING_BOUNCE_COUNT;

  // firework spark sources (win only): per-source emission rate + colour, and
  // the spawn requests produced this tick (drained by the render layer).
  private readonly sparkRate = new Array<number>(CSPARK_SOURCE_NUMBER).fill(0);
  private readonly sparkColor = new Array<number>(CSPARK_SOURCE_NUMBER).fill(0);
  private sparkSpawns: CelebrationSparkSpawn[] = [];

  constructor(private readonly rng: CelebrationRng = defaultRng) {}

  /** Whether a celebration is currently running. */
  get active(): boolean {
    return this.running;
  }

  /** Begin the celebration for `outcome` (CelebrationManager::gameFinish). */
  start(outcome: CelebrationOutcome): void {
    this.running = true;
    this.outcome = outcome;
    this.t = 0;
    this.lightLevel = 1;
    this.done = false;
    this.winAlpha = 0;
    this.winScale = STARTING_WIN_SCALE;
    this.winFlash1 = 0;
    this.winFlash2 = 0;
    this.lossHeight = STARTING_LOSS_HEIGHT;
    this.lossVelocity = 0;
    this.lossBounce = STARTING_BOUNCE_COUNT;
    this.sparkRate.fill(0);
    this.sparkColor.fill(0);
    this.sparkSpawns = [];
  }

  /** Reset to idle (no celebration). */
  stop(): void {
    this.running = false;
  }

  /** Take the firework spawn requests emitted since the last drain (render layer). */
  drainSparkSpawns(): CelebrationSparkSpawn[] {
    if (this.sparkSpawns.length === 0) return [];
    const out = this.sparkSpawns;
    this.sparkSpawns = [];
    return out;
  }

  /** Advance one tick (CelebrationManager::timeStep). No-op when not running. */
  tick(): void {
    if (!this.running) return;

    // Board fade-out (light_level → 0), then celebration-complete signal.
    if (this.t < CELEBRATION_FADE_TIME) {
      this.lightLevel = (CELEBRATION_FADE_TIME - this.t) / CELEBRATION_FADE_TIME;
    } else if (this.t === CELEBRATION_FADE_TIME) {
      this.lightLevel = 0;
    } else if (this.t === CELEBRATION_TIME) {
      this.done = true;
    }

    if (this.outcome === 'win') this.tickWin();
    else this.tickLoss();

    this.t++;
  }

  private tickWin(): void {
    if (this.t < WIN_FADE_TIME) {
      // fade in + shrink from the giant starting scale
      this.winAlpha += 1 / WIN_FADE_TIME;
      this.winScale -= (STARTING_WIN_SCALE - 1) / WIN_FADE_TIME;
    } else if (this.t === WIN_FADE_TIME) {
      this.winAlpha = 1;
      this.winScale = 1;
      this.winFlash1 = WIN_FLASH_1_TIME;
      this.winFlash2 = WIN_FLASH_2_TIME;
      // Seed the firework sources: one starts at full rate, the rest ramping.
      this.sparkRate[CSPARK_SOURCE_NUMBER - 1] = CSPARK_FULL_RATE;
      this.sparkColor[CSPARK_SOURCE_NUMBER - 1] = this.rng.number(CSPARK_COLOR_NUMBER);
      for (let n = 0; n < CSPARK_SOURCE_NUMBER - 1; n++) {
        this.sparkRate[n] = CSPARK_STARTING_RATE;
        this.sparkColor[n] = this.rng.number(CSPARK_COLOR_NUMBER);
      }
    } else {
      // strobe: count down, and randomly re-arm / fold the flash timers
      if (this.winFlash1) this.winFlash1--;
      if (this.rng.chanceIn(WIN_FLASH_1_CHANCE_IN)) {
        if (this.winFlash1) {
          if (this.winFlash1 < WIN_FLASH_1_TIME / 2)
            this.winFlash1 = WIN_FLASH_1_TIME / 2 - this.winFlash1;
        } else this.winFlash1 = WIN_FLASH_1_TIME;
      }
      if (this.winFlash2) this.winFlash2--;
      if (this.rng.chanceIn(WIN_FLASH_2_CHANCE_IN)) {
        if (this.winFlash2) {
          if (this.winFlash2 < WIN_FLASH_2_TIME / 2)
            this.winFlash2 = WIN_FLASH_2_TIME / 2 - this.winFlash2;
        } else this.winFlash2 = WIN_FLASH_2_TIME;
      }
      // Fireworks: each source's rate sputters (decays with random boosts); when
      // a random draw falls under the rate, launch a spark (CelebrationManager).
      for (let n = 0; n < CSPARK_SOURCE_NUMBER; n++) {
        if (this.sparkRate[n]! > CSPARK_LOW_RATE) this.sparkRate[n]! -= CSPARK_QUICK_RATE_DROP;
        else if (this.sparkRate[n]! > 0) this.sparkRate[n]!--;

        if (this.rng.chanceIn(CSPARK_BOOST_CHANCE_IN)) {
          this.sparkRate[n]! += CSPARK_RATE_BOOST;
          if (this.rng.chanceIn(CSPARK_COLOR_CHANGE_CHANCE_IN))
            this.sparkColor[n] = this.rng.number(CSPARK_COLOR_NUMBER);
        }

        if (this.rng.number(CSPARK_FULL_RATE) < this.sparkRate[n]!) {
          this.sparkSpawns.push({ source: n, color: this.sparkColor[n]! });
        }
      }
    }
  }

  private tickLoss(): void {
    if (this.lossBounce === FINAL_BOUNCE_COUNT - 1) return; // settled

    this.lossHeight += this.lossVelocity;
    this.lossVelocity += -LOSS_GRAVITY - LOSS_DRAG * this.lossVelocity;

    if (this.lossHeight < 0) {
      if (this.lossBounce === FINAL_BOUNCE_COUNT) {
        // final landing
        this.lossBounce--;
        this.lossVelocity = 0;
        this.lossHeight = 0;
      } else if (this.lossVelocity > -LOSS_MIN_VELOCITY) {
        // near the end: reduce elasticity as the bounces die out
        this.lossBounce--;
        this.lossVelocity = -LOSS_END_BOUNCE_ELASTICITY * this.lossBounce * this.lossVelocity;
        this.lossHeight = -this.lossHeight;
      } else {
        this.lossHeight = -this.lossHeight;
        this.lossVelocity = -LOSS_BOUNCE_ELASTICITY * this.lossVelocity;
      }
    }
  }

  /** The current frame's render values. */
  get view(): CelebrationView {
    const boardDim = 1 - this.lightLevel;
    if (this.outcome === 'win') {
      // opacity = win_alpha^4 until static (DrawMessages.cxx:117-122).
      const a2 = this.winAlpha * this.winAlpha;
      const opacity = this.winAlpha >= 1 ? 1 : a2 * a2;
      return {
        boardDim,
        opacity,
        scale: this.winScale,
        dropFraction: 0,
        flash: Math.max(
          foldedFlash(this.winFlash1, WIN_FLASH_1_TIME),
          foldedFlash(this.winFlash2, WIN_FLASH_2_TIME),
        ),
        complete: this.done,
      };
    }
    return {
      boardDim,
      opacity: 1,
      scale: 1,
      dropFraction: Math.max(0, this.lossHeight) / STARTING_LOSS_HEIGHT,
      flash: 0,
      complete: this.done,
    };
  }
}

/** The DrawMessages triangle-wave flash intensity for a timer (0..1). */
function foldedFlash(timer: number, period: number): number {
  if (!timer) return 0;
  let f = timer * (2 / period);
  if (f > 1) f = 2 - f;
  return f * f;
}
