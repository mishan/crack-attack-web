/**
 * volume.ts — pure volume math for the audio layer.
 *
 * Keeps the gain calculations out of the WebAudio glue so they can be unit
 * tested. Mirrors the C++ mixer's scaling: `Sound::play` clamps the event
 * volume to 10 then scales linearly to the mixer max (`vol * MAX / 10`,
 * Sound.cxx:99-101), and music runs at a quarter of full (`MIX_MAX_VOLUME / 4`,
 * Music.cxx). Those faithful levels become the *defaults*; the user's mute and
 * 0..1 volume sliders multiply on top.
 *
 * Original work Copyright (C) 2003 Miguel Ángel Vilela García. GPL-2.0-or-later.
 */

/** The C++ cap on a sound event's integer volume (Sound.cxx:98). */
export const SOUND_VOLUME_MAX = 10;

/** Faithful music level: a quarter of full (Music.cxx `MIX_MAX_VOLUME / 4`). */
export const MUSIC_BASE_GAIN = 0.25;

/**
 * Clamp a number into [lo, hi]. Non-finite input (NaN/±Infinity, e.g. from
 * corrupted localStorage settings) collapses to `lo` so gain math never yields
 * NaN — WebAudio gain and `HTMLAudioElement.volume` throw or misbehave on NaN.
 */
export function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Final linear gain (0..1) for a sound cue: the C++ `min(vol, 10) / 10`
 * mapping, times the user's SFX volume, zeroed when muted.
 */
export function sfxGain(eventVolume: number, userSfx: number, muted: boolean): number {
  if (muted) return 0;
  const base = clamp(eventVolume, 0, SOUND_VOLUME_MAX) / SOUND_VOLUME_MAX;
  return base * clamp(userSfx, 0, 1);
}

/**
 * Final linear gain (0..1) for music: the faithful quarter-volume base times
 * the user's music volume, zeroed when muted.
 */
export function musicGain(userMusic: number, muted: boolean): number {
  if (muted) return 0;
  return MUSIC_BASE_GAIN * clamp(userMusic, 0, 1);
}
