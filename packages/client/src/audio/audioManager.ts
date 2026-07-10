/**
 * audioManager.ts — the WebAudio platform layer for gameplay sound and music.
 *
 * The deterministic core never makes noise; it only *reports* sound cues
 * (`GameSim.drainSoundEvents`) and the client's countdown/lifecycle code knows
 * when music should change. This manager turns those into actual audio, faithful
 * to the C++ `Sound.{h,cxx}` (SDL_mixer chunks) and `Music.{h,cxx}` state
 * machine (prelude → game loop → gameover/youwin, with fades and pause/resume).
 *
 * Two backends: short SFX play through a WebAudio `AudioContext` (low latency,
 * polyphonic — many pops can overlap), music streams through a single
 * `HTMLAudioElement` (easy looping + pause/resume). Browsers gate audio behind a
 * user gesture, so nothing sounds until {@link unlock} runs on the first input;
 * a music request made before then is remembered and started on unlock.
 *
 * Volume math (mute + the 0..1 sliders over the faithful C++ levels) lives in
 * the pure, tested `volume.ts`. Settings persist in localStorage.
 *
 * Original work Copyright (C) 2003 Miguel Ángel Vilela García. GPL-2.0-or-later.
 */

import type { SoundId } from '@crack-attack/core';
import { countdownBeepsFired, COUNTDOWN_BEEP_VOLUMES } from '../view/messages.js';
import { musicGain, sfxGain } from './volume.js';

/** The four music tracks (C++ `GC_MUSIC_*_TRACK`). */
export type MusicTrack = 'prelude' | 'game' | 'gameover' | 'youwin';

const SFX_FILES: Record<SoundId, string> = {
  countdown: 'countdown.wav',
  block_fallen: 'block_fallen.wav',
  block_awaking: 'block_awaking.wav',
  block_dying: 'block_dying.wav',
  garbage_fallen: 'garbage_fallen.wav',
  garbage_shattering: 'garbage_shattering.wav',
};

const MUSIC_FILES: Record<MusicTrack, string> = {
  prelude: 'prelude.ogg',
  game: 'game.ogg',
  gameover: 'gameover.ogg',
  youwin: 'youwin.ogg',
};

/** User-adjustable audio settings, persisted across sessions. */
export interface AudioSettings {
  muted: boolean;
  /** Music volume, 0..1 (multiplies the faithful quarter-volume base). */
  music: number;
  /** SFX volume, 0..1 (multiplies the per-cue C++ level). */
  sfx: number;
}

const STORAGE_KEY = 'ca.audio.settings';

const DEFAULT_SETTINGS: AudioSettings = { muted: false, music: 1, sfx: 1 };

function loadSettings(): AudioSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AudioSettings>;
    return {
      muted: typeof parsed.muted === 'boolean' ? parsed.muted : DEFAULT_SETTINGS.muted,
      music: typeof parsed.music === 'number' ? parsed.music : DEFAULT_SETTINGS.music,
      sfx: typeof parsed.sfx === 'number' ? parsed.sfx : DEFAULT_SETTINGS.sfx,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Resolve a public asset path the same way the render layer does. */
function assetUrl(subdir: string, file: string): string {
  return new URL(`${subdir}/${file}`, document.baseURI).href;
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private readonly sfxBuffers = new Map<SoundId, AudioBuffer>();
  private buffersRequested = false;

  private readonly musicEl: HTMLAudioElement;
  private currentTrack: MusicTrack | null = null;
  /** A track requested before unlock; started once a gesture arrives. */
  private pendingTrack: { track: MusicTrack; loop: boolean } | null = null;
  private fadeRaf = 0;

  private settings: AudioSettings;
  private unlocked = false;

  /** Countdown beeps already played this game (see {@link updateCountdown}). */
  private beepsPlayed = 0;

  constructor() {
    this.settings = loadSettings();
    this.musicEl = new Audio();
    this.musicEl.preload = 'auto';
    this.applyMusicVolume();
    // The game track loops (C++ keep_playing replays it); we toggle loop per play.
    this.musicEl.addEventListener('ended', () => {
      this.currentTrack = null;
    });
  }

  // --- unlock / loading ------------------------------------------------------

  /**
   * Called on the first user gesture. Creates/resumes the AudioContext, starts
   * decoding SFX, and launches any music requested before the gesture. Safe to
   * call repeatedly.
   */
  unlock(): void {
    if (!this.ctx) {
      const Ctor =
        globalThis.AudioContext ??
        (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) this.ctx = new Ctor();
    }
    // Only resume when actually suspended (avoids needless work on every gesture).
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
    this.loadSfx(); // guarded internally — decodes once
    this.unlocked = true;
    // Retry a track whose play() was rejected earlier (autoplay/resume block).
    if (this.pendingTrack) {
      const { track, loop } = this.pendingTrack;
      this.pendingTrack = null;
      this.playMusic(track, loop);
    }
  }

  private loadSfx(): void {
    if (this.buffersRequested || !this.ctx) return;
    this.buffersRequested = true;
    const ctx = this.ctx;
    for (const [id, file] of Object.entries(SFX_FILES) as [SoundId, string][]) {
      fetch(assetUrl('sounds', file))
        .then((r) => r.arrayBuffer())
        .then((buf) => ctx.decodeAudioData(buf))
        .then((decoded) => this.sfxBuffers.set(id, decoded))
        .catch(() => {
          /* a missing/undecodable cue is non-fatal — that sound just stays silent */
        });
    }
  }

  // --- SFX -------------------------------------------------------------------

  /**
   * Play a sound cue. `volume` is the core's integer 0..10 scale; it's mapped to
   * gain in {@link sfxGain}. No-op until unlocked / decoded, or when muted.
   */
  play(sound: SoundId, volume: number): void {
    if (!this.ctx || this.settings.muted) return;
    const buffer = this.sfxBuffers.get(sound);
    if (!buffer) return;
    const gain = sfxGain(volume, this.settings.sfx, this.settings.muted);
    if (gain <= 0) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.ctx.destination);
    src.start();
  }

  /**
   * Drain-and-play helper: feed it a batch of {@link SoundEvent}-shaped cues
   * (from `GameSim.drainSoundEvents`). Keeps the drivers a one-liner.
   */
  playCues(cues: readonly { sound: SoundId; volume: number }[]): void {
    for (const c of cues) this.play(c.sound, c.volume);
  }

  // --- countdown -------------------------------------------------------------

  /** Reset the countdown beep tracker at the start of a fresh game. */
  resetCountdown(): void {
    this.beepsPlayed = 0;
  }

  /**
   * Mark the countdown as already elapsed (a resume or mid-match spectate that
   * skips the 3-2-1 gate) so {@link updateCountdown} won't fire a burst of beeps.
   */
  skipCountdown(): void {
    this.beepsPlayed = COUNTDOWN_BEEP_VOLUMES.length;
  }

  /**
   * Play any countdown beeps due by `metaTicks` that haven't sounded yet. Driven
   * by the client's countdown timeline (the beep schedule is the pure
   * {@link countdownBeepsFired}); works whether metaTicks steps or jumps.
   */
  updateCountdown(metaTicks: number): void {
    const due = countdownBeepsFired(metaTicks);
    for (; this.beepsPlayed < due; this.beepsPlayed++) {
      this.play('countdown', COUNTDOWN_BEEP_VOLUMES[this.beepsPlayed] ?? 1);
    }
  }

  // --- music -----------------------------------------------------------------

  /**
   * Start a music track. Before unlock the request is remembered and started on
   * the first gesture. `loop` mirrors the C++ `keep_playing` replay (game track).
   */
  playMusic(track: MusicTrack, loop: boolean): void {
    this.cancelFade();
    if (!this.unlocked) {
      this.pendingTrack = { track, loop };
      return;
    }
    this.currentTrack = track;
    this.musicEl.loop = loop;
    this.musicEl.src = assetUrl('music', MUSIC_FILES[track]);
    this.applyMusicVolume();
    void this.musicEl.play().catch(() => {
      /* autoplay may still be blocked; the next gesture retries via unlock() */
      this.pendingTrack = { track, loop };
    });
  }

  /** C++ `Music::play_prelude` — menu music, once. */
  playPrelude(): void {
    this.playMusic('prelude', false);
  }

  /** C++ `Music::play` at GO — the game loop. */
  playGame(): void {
    this.playMusic('game', true);
  }

  /** C++ `Music::play_gameover` (CelebrationManager loser branch). */
  playGameOver(): void {
    this.playMusic('gameover', false);
  }

  /** C++ `Music::play_youwin` (CelebrationManager winner branch). */
  playYouWin(): void {
    this.playMusic('youwin', false);
  }

  /** C++ `Music::pause` — freeze the current track (tab hidden / game paused). */
  pauseMusic(): void {
    if (!this.musicEl.paused) this.musicEl.pause();
  }

  /** C++ `Music::resume`. */
  resumeMusic(): void {
    if (this.currentTrack && this.musicEl.paused && this.unlocked) {
      void this.musicEl.play().catch(() => {});
    }
  }

  /** C++ `Music::stop`. */
  stopMusic(): void {
    this.cancelFade();
    this.musicEl.pause();
    this.currentTrack = null;
    this.pendingTrack = null;
  }

  /**
   * C++ `Music::fadeout(ms)` — linearly ramp the current track to silence over
   * `ms`, then stop. Used at game start (fade the prelude, 3000 ms) and at match
   * end before the stinger (1000 ms).
   */
  fadeoutMusic(ms: number): void {
    this.cancelFade();
    // Requested before unlock: drop the pending track so it doesn't start later
    // mid-countdown at full volume (there's nothing audible to fade yet).
    if (!this.unlocked) {
      this.pendingTrack = null;
      return;
    }
    if (!this.currentTrack || this.musicEl.paused) return;
    // Non-positive duration → immediate stop (avoids a divide-by-zero NaN volume).
    if (ms <= 0) {
      this.stopMusic();
      return;
    }
    const start = performance.now();
    const from = this.musicEl.volume;
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / ms);
      this.musicEl.volume = from * (1 - t);
      if (t >= 1) {
        this.stopMusic();
      } else {
        this.fadeRaf = requestAnimationFrame(step);
      }
    };
    this.fadeRaf = requestAnimationFrame(step);
  }

  private cancelFade(): void {
    if (this.fadeRaf) {
      cancelAnimationFrame(this.fadeRaf);
      this.fadeRaf = 0;
    }
  }

  private applyMusicVolume(): void {
    this.musicEl.volume = musicGain(this.settings.music, this.settings.muted);
  }

  // --- settings --------------------------------------------------------------

  getSettings(): AudioSettings {
    return { ...this.settings };
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      /* storage may be unavailable (private mode) — settings just don't persist */
    }
  }

  setMuted(muted: boolean): void {
    this.settings.muted = muted;
    this.applyMusicVolume();
    this.persist();
  }

  toggleMuted(): boolean {
    this.setMuted(!this.settings.muted);
    return this.settings.muted;
  }

  setMusicVolume(v: number): void {
    this.settings.music = v;
    this.applyMusicVolume();
    this.persist();
  }

  setSfxVolume(v: number): void {
    this.settings.sfx = v;
    this.persist();
  }

  dispose(): void {
    this.cancelFade();
    this.stopMusic();
    void this.ctx?.close();
    this.ctx = null;
  }
}
