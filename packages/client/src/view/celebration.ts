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
 * Divergence: the reference's sputtering firework "celebration sparks"
 * (SparkleManager::createCelebrationSpark) and the exact win-message tint are
 * not ported — the win flash is reproduced as a brightness pulse on the white
 * message.
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

export type CelebrationOutcome = 'win' | 'loss';

/** What the render layer needs to draw the celebration for a frame. */
export interface CelebrationView {
  /** How dark the board should be, 0..1 (1 = black). = 1 - light_level. */
  readonly boardDim: number;
  /** Result-message opacity, 0..1. */
  readonly opacity: number;
  /** Result-message scale multiplier (win scales 12→1; loss stays 1). */
  readonly scale: number;
  /** Downward drop offset as a fraction of the start height, 0..1 (loss bounce). */
  readonly dropFraction: number;
  /** Extra brightness pulse, 0..1 (win strobes). */
  readonly flash: number;
  /** True once the celebration has fully settled (user may restart). */
  readonly complete: boolean;
}

/** A 1-in-`n` chance; default uses `Math.random` (cosmetic — never gameplay). */
export type ChanceFn = (n: number) => boolean;

const defaultChance: ChanceFn = (n) => Math.floor(Math.random() * n) === 0;

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

  constructor(private readonly chance: ChanceFn = defaultChance) {}

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
  }

  /** Reset to idle (no celebration). */
  stop(): void {
    this.running = false;
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
    } else {
      // strobe: count down, and randomly re-arm / fold the flash timers
      if (this.winFlash1) this.winFlash1--;
      if (this.chance(WIN_FLASH_1_CHANCE_IN)) {
        if (this.winFlash1) {
          if (this.winFlash1 < WIN_FLASH_1_TIME / 2)
            this.winFlash1 = WIN_FLASH_1_TIME / 2 - this.winFlash1;
        } else this.winFlash1 = WIN_FLASH_1_TIME;
      }
      if (this.winFlash2) this.winFlash2--;
      if (this.chance(WIN_FLASH_2_CHANCE_IN)) {
        if (this.winFlash2) {
          if (this.winFlash2 < WIN_FLASH_2_TIME / 2)
            this.winFlash2 = WIN_FLASH_2_TIME / 2 - this.winFlash2;
        } else this.winFlash2 = WIN_FLASH_2_TIME;
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
