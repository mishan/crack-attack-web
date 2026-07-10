/**
 * levelLights.ts — pure logic for the side "level light" danger indicators.
 *
 * Faithful port of the `LevelLights` state machine (`LevelLights.{h,cxx}`) and
 * the color math of `DrawLevelLights.cxx`. A column of arrow lights runs down
 * each side, one per playable row: red at or below the stack top, blue above —
 * but rather than snapping, lights *fade* between the two
 * (DC_LEVEL_LIGHT_FADE_TIME), flash white when garbage lands on their rows
 * (LS_IMPACT_FLASH, with the reference's inflection-resync so repeated impacts
 * chain smoothly), and the whole column strobes while the loss countdown runs
 * (the death flash, DC_LEVEL_LIGHT_DEATH_FLASH_TIME).
 *
 * This is DOM-free decision logic; `render/levelLightsView.ts` draws it. In
 * solo (and for now netplay, where each board has its own local sim) both
 * sides mirror the same set, as the original does without an opponent.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import { GC_SAFE_HEIGHT } from '@crack-attack/core';

/** Number of level lights per side (`LL_NUMBER_LEVEL_LIGHTS`). */
export const LEVEL_LIGHT_COUNT = GC_SAFE_HEIGHT - 1;

// Light states (LevelLights.h:41-45).
const LS_RED = 1 << 0;
const LS_BLUE = 1 << 1;
const LS_FADE_TO_RED = 1 << 2;
const LS_FADE_TO_BLUE = 1 << 3;
const LS_IMPACT_FLASH = 1 << 4;

// Display constants (Displayer.h:332-337).
const DC_LEVEL_LIGHT_FADE_TIME = 150;
const DC_LEVEL_LIGHT_IMPACT_FLASH_TIME = 20;
const DC_LEVEL_LIGHT_FLASH_INFLECTION = 0.9;
const DC_LEVEL_LIGHT_DEATH_FLASH_TIME = 12;
const DC_LEVEL_LIGHT_RED = 0.7;
const DC_LEVEL_LIGHT_BLUE = 0.7;

/**
 * Whether the light at `index` (0 = bottom) is red rather than blue in steady
 * state. Light `index` sits at playable grid row `index + 1`; it is red once
 * that row is at or below the stack top. (The steady-state predicate behind
 * `levelRaise`/`levelLower`; the machine below adds the transitions.)
 */
export function isLevelLightRed(index: number, topEffectiveRow: number): boolean {
  return index < topEffectiveRow;
}

interface Light {
  state: number;
  fade_alarm: number;
  flash_alarm: number;
}

export class LevelLightsState {
  private readonly lights: Light[] = [];
  /** -1 = not death-flashing; otherwise counts DC_..._DEATH_FLASH_TIME → 0. */
  private death_flash_alarm = -1;

  constructor() {
    for (let n = 0; n < LEVEL_LIGHT_COUNT; n++) {
      this.lights.push({ state: LS_BLUE, fade_alarm: 0, flash_alarm: 0 });
    }
  }

  /** Reset for a new game at the given starting stack height. Mirrors `gameStart`. */
  gameStart(topEffectiveRow: number): void {
    for (let n = 0; n < LEVEL_LIGHT_COUNT; n++) {
      const light = this.lights[n]!;
      light.state = LS_BLUE;
      light.fade_alarm = 0;
      light.flash_alarm = 0;
      if (n < topEffectiveRow) this.setRed(light);
    }
    this.death_flash_alarm = -1;
  }

  /**
   * Garbage landed covering rows `y .. y + height - 1`: impact-flash their
   * lights. Mirrors `LevelLights::notifyImpact` (LevelLights.h:89-101),
   * including the clamp to the light column.
   */
  notifyImpact(y: number, height: number): void {
    if (y - 1 + height > LEVEL_LIGHT_COUNT) {
      height = LEVEL_LIGHT_COUNT - y + 1;
      if (height < 1) return;
    }
    while (height--) {
      this.setFlashing(this.lights[y - 1 + height]!);
    }
  }

  /**
   * Advance one 50 Hz tick. `topEffectiveRow` drives the red/blue boundary
   * (the idempotent equivalent of the C++'s event-driven `levelRaise`/
   * `levelLower` calls); `gameLive` gates death-flash re-arming (the C++'s
   * `MS_GAME_PLAY && checkSafeHeightViolation()`, LevelLights.cxx:88-92).
   */
  tick(topEffectiveRow: number, gameLive: boolean): void {
    this.levelRaise(topEffectiveRow);
    this.levelLower(topEffectiveRow);

    const violation = topEffectiveRow >= GC_SAFE_HEIGHT - 1;
    // Creep.cxx:121: entering a safe-height violation starts the death flash
    // (the -1 guard makes calling this every violating tick equivalent). Only
    // a *live* game can arm it — in the C++ the trigger sits inside Creep's
    // gameplay tick, which stops at game over.
    if (gameLive && violation && this.death_flash_alarm === -1) {
      this.death_flash_alarm = DC_LEVEL_LIGHT_DEATH_FLASH_TIME;
    }

    // LevelLights::timeStep (LevelLights.cxx:63-92).
    for (let n = 0; n < LEVEL_LIGHT_COUNT; n++) {
      const light = this.lights[n]!;
      if (light.state & (LS_FADE_TO_RED | LS_FADE_TO_BLUE)) {
        if (light.fade_alarm-- === 0) {
          light.state |= light.state & LS_FADE_TO_RED ? LS_RED : LS_BLUE;
          light.state &= ~(LS_FADE_TO_RED | LS_FADE_TO_BLUE);
        }
      }
      if (light.state & LS_IMPACT_FLASH) {
        if (light.flash_alarm-- === 0) light.state &= ~LS_IMPACT_FLASH;
      }
    }
    if (this.death_flash_alarm !== -1) {
      const expired = this.death_flash_alarm === 0;
      this.death_flash_alarm--;
      if (expired && gameLive && violation) {
        this.death_flash_alarm = DC_LEVEL_LIGHT_DEATH_FLASH_TIME;
      }
    }
  }

  /**
   * The light's current [r, g, b], all effects applied. Faithful to
   * `DrawLevelLights.cxx:95-141` (sqrt crossfade, piecewise-quadratic impact
   * pulse toward white, death-flash whitening).
   */
  color(n: number): [number, number, number] {
    const light = this.lights[n]!;
    let r = 0;
    let g = 0;
    let b = 0;

    if (light.state & LS_RED) {
      r = DC_LEVEL_LIGHT_RED;
    } else if (light.state & LS_BLUE) {
      b = DC_LEVEL_LIGHT_BLUE;
    } else {
      const fade = light.fade_alarm / DC_LEVEL_LIGHT_FADE_TIME;
      if (light.state & LS_FADE_TO_RED) {
        r = DC_LEVEL_LIGHT_RED * Math.sqrt(1 - fade);
        b = DC_LEVEL_LIGHT_BLUE * Math.sqrt(fade);
      } else {
        r = DC_LEVEL_LIGHT_RED * Math.sqrt(fade);
        b = DC_LEVEL_LIGHT_BLUE * Math.sqrt(1 - fade);
      }
    }

    if (light.state & LS_IMPACT_FLASH) {
      let flash = light.flash_alarm / DC_LEVEL_LIGHT_IMPACT_FLASH_TIME;
      if (flash > DC_LEVEL_LIGHT_FLASH_INFLECTION) {
        flash = (1 - flash) / (1 - DC_LEVEL_LIGHT_FLASH_INFLECTION);
      } else {
        flash /= DC_LEVEL_LIGHT_FLASH_INFLECTION;
      }
      flash *= flash;
      r += (1 - r) * flash;
      g = flash;
      b += (1 - b) * flash;
    }

    if (this.death_flash_alarm !== -1) {
      let df = this.death_flash_alarm * (2 / DC_LEVEL_LIGHT_DEATH_FLASH_TIME);
      if (df > 1) df = 2 - df;
      r += (1 - r) * df;
      g += (1 - g) * df;
      b += (1 - b) * df;
    }

    return [r, g, b];
  }

  /** Whether the death flash is currently running (inspection/test helper). */
  get deathFlashing(): boolean {
    return this.death_flash_alarm !== -1;
  }

  // --- transitions (LevelLights.h:147-186) -----------------------------------

  /** Set red every light from `topEffectiveRow - 1` down to the first already-red. */
  private levelRaise(topEffectiveRow: number): void {
    let n = Math.min(topEffectiveRow - 1, LEVEL_LIGHT_COUNT - 1);
    while (n >= 0) {
      const light = this.lights[n]!;
      if (light.state & (LS_RED | LS_FADE_TO_RED)) break;
      this.setRed(light);
      n--;
    }
  }

  /** Set blue every light from `topEffectiveRow` up to the first already-blue. */
  private levelLower(topEffectiveRow: number): void {
    let n = topEffectiveRow;
    while (n < LEVEL_LIGHT_COUNT) {
      const light = this.lights[n]!;
      if (light.state & (LS_BLUE | LS_FADE_TO_BLUE)) break;
      this.setBlue(light);
      n++;
    }
  }

  private setBlue(light: Light): void {
    // Mid-fade reversals keep their visual position (alarm mirrored).
    light.fade_alarm =
      light.state & LS_FADE_TO_RED
        ? DC_LEVEL_LIGHT_FADE_TIME - light.fade_alarm
        : DC_LEVEL_LIGHT_FADE_TIME;
    light.state &= ~(LS_RED | LS_FADE_TO_RED);
    light.state |= LS_FADE_TO_BLUE;
  }

  private setRed(light: Light): void {
    light.fade_alarm =
      light.state & LS_FADE_TO_BLUE
        ? DC_LEVEL_LIGHT_FADE_TIME - light.fade_alarm
        : DC_LEVEL_LIGHT_FADE_TIME;
    light.state &= ~(LS_BLUE | LS_FADE_TO_BLUE);
    light.state |= LS_FADE_TO_RED;
  }

  private setFlashing(light: Light): void {
    if (light.state & LS_IMPACT_FLASH) {
      // Past the inflection: resync so chained impacts pulse continuously
      // (LevelLights.h:169-178).
      const inflection = DC_LEVEL_LIGHT_FLASH_INFLECTION * DC_LEVEL_LIGHT_IMPACT_FLASH_TIME;
      if (light.flash_alarm < inflection) {
        light.flash_alarm = Math.trunc(
          inflection +
            (1 - DC_LEVEL_LIGHT_FLASH_INFLECTION) *
              DC_LEVEL_LIGHT_IMPACT_FLASH_TIME *
              (1 - light.flash_alarm / inflection),
        );
      }
    } else {
      light.state |= LS_IMPACT_FLASH;
      light.flash_alarm = DC_LEVEL_LIGHT_IMPACT_FLASH_TIME;
    }
  }
}
