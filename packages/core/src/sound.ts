/**
 * sound.ts
 *
 * Sound cues: the little audio hits the original fires on gameplay events — a
 * block landing, an awaking block popping in, a dying block, a garbage slab
 * hitting the floor or shattering, and the 3-2-1 countdown ticks. In the C++
 * these are `Sound::play(GC_SOUND_*, vol)` calls scattered through `Block.cxx`,
 * `Garbage.cxx`, and `CountDownManager.cxx` (see `Sound.{h,cxx}`, SDL_mixer).
 *
 * Like signs and sparkles, sound is purely cosmetic, so the deterministic core
 * does **not** own playback — it only *reports* that a cue should fire, via a
 * `(SoundId, volume)` pair on a {@link SoundSink} (buffered as a
 * {@link SoundEvent}). Emitting a cue draws **no**
 * gameplay RNG and never enters the digest, so audio can't perturb the
 * load-bearing draw order or replay determinism. The client (WebAudio) turns
 * these events into actual sound.
 *
 * The `countdown` cue is driven by the client's countdown timeline (which owns
 * the `CountDownManager` schedule in the display layer), not by the core tick;
 * it is listed here so the id set matches the C++ `GC_SOUND_*` table 1:1.
 *
 * Original work Copyright (C) 2003 Miguel Ángel Vilela García. GPL-2.0-or-later.
 */

/**
 * The six sound cues, matching the C++ `GC_SOUND_*` filenames (Sound.h:31-36).
 * The value is the base filename (sans extension) so the client can resolve it
 * to an asset path directly.
 */
export type SoundId =
  | 'countdown'
  | 'block_fallen'
  | 'block_awaking'
  | 'block_dying'
  | 'garbage_fallen'
  | 'garbage_shattering';

/**
 * A request to play one sound cue, in the same terms the C++ `Sound::play(file,
 * vol)` receives: the cue id and a `volume` on the original's integer 0..10
 * scale (`Sound::play` clamps to 10, then scales to the mixer's max). Left
 * unclamped here — exactly as the core computes it (e.g. `width * height` for a
 * garbage impact) — so the display layer applies the same `min(vol, 10) / 10`
 * mapping the C++ mixer does.
 */
export interface SoundEvent {
  readonly sound: SoundId;
  readonly volume: number;
}

/**
 * Where gameplay code reports sound cues. The core hands the display layer these
 * events and never reads them back; a headless run (tests, server, replay) can
 * leave the sink unset (the emitters null-check it), and it has zero effect on
 * simulation state.
 */
export interface SoundSink {
  notifyCosmeticSound(sound: SoundId, volume: number): void;
}
