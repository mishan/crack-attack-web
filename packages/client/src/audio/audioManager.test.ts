import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioManager } from './audioManager.js';

/** Just enough HTMLAudioElement for the music path. */
class FakeAudio {
  src = '';
  loop = false;
  volume = 1;
  preload = '';
  paused = true;
  /** Make the next play() reject, as a browser's autoplay block does. */
  rejectNextPlay = false;
  play(): Promise<void> {
    if (this.rejectNextPlay) {
      this.rejectNextPlay = false;
      return Promise.reject(new Error('NotAllowedError: autoplay blocked'));
    }
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  addEventListener(): void {}
}

let store: Map<string, string>;
let audioEls: FakeAudio[];

beforeEach(() => {
  store = new Map();
  audioEls = [];
  vi.stubGlobal('localStorage', {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => void store.set(k, v),
  });
  vi.stubGlobal(
    'Audio',
    class extends FakeAudio {
      constructor() {
        super();
        audioEls.push(this);
      }
    },
  );
  vi.stubGlobal('document', { baseURI: 'http://game.test/' });
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running';
      resume(): Promise<void> {
        return Promise.resolve();
      }
      decodeAudioData(): Promise<never> {
        return Promise.reject(new Error('no decoding in tests'));
      }
    },
  );
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
});
afterEach(() => vi.unstubAllGlobals());

/** The manager's single music element. */
const music = (): FakeAudio => audioEls[0]!;
/** Let pending play() rejections run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** A returning player who has music turned on. */
const musicOn = (): void =>
  void store.set('ca.audio.settings', JSON.stringify({ muted: false, music: 1, sfx: 1 }));

describe('AudioManager music', () => {
  it('starts with music off and sound effects on for a first-time player', () => {
    expect(new AudioManager().getSettings()).toMatchObject({ muted: false, music: 0, sfx: 1 });
  });

  it('streams nothing while music is off', () => {
    const audio = new AudioManager();
    audio.unlock();
    audio.playPrelude();
    expect(music().src).toBe('');
    expect(music().paused).toBe(true);
  });

  it('starts the wanted track when music is turned up, and stops it when turned down', () => {
    const audio = new AudioManager();
    audio.unlock();
    audio.playGame();
    audio.setMusicVolume(0.5);
    expect(music().src).toContain('music/game.ogg');
    expect(music().loop).toBe(true);
    expect(music().paused).toBe(false);

    audio.setMusicVolume(0);
    expect(music().paused).toBe(true);
    audio.setMusicVolume(1);
    expect(music().paused).toBe(false);
  });

  it('forgets a faded-out track rather than starting it later', () => {
    const audio = new AudioManager();
    audio.unlock();
    audio.playPrelude();
    audio.fadeoutMusic(3000); // game start: the prelude is on its way out
    audio.setMusicVolume(1);
    expect(music().src).toBe('');
  });

  it("keeps a returning player's saved music volume", () => {
    store.set('ca.audio.settings', JSON.stringify({ muted: false, music: 0.8, sfx: 1 }));
    const audio = new AudioManager();
    expect(audio.getSettings().music).toBe(0.8);
    audio.unlock();
    audio.playPrelude();
    expect(music().src).toContain('music/prelude.ogg');
    expect(music().paused).toBe(false);
  });

  it('retries a blocked track on the next gesture', async () => {
    musicOn();
    const audio = new AudioManager();
    audio.unlock();
    music().rejectNextPlay = true;
    audio.playGame();
    await settle();
    expect(music().paused).toBe(true);

    audio.unlock(); // the next gesture
    expect(music().src).toContain('music/game.ogg');
    expect(music().paused).toBe(false);
  });

  it('never lets an older blocked request override a newer track', async () => {
    musicOn();
    const audio = new AudioManager();
    audio.unlock();
    music().rejectNextPlay = true;
    audio.playPrelude(); // blocked; its rejection lands after the next request
    audio.playGame();
    await settle();

    audio.unlock(); // a later gesture must not bring the prelude back
    expect(music().src).toContain('music/game.ogg');
    expect(music().paused).toBe(false);
  });

  it('does not revive an older blocked track while music is off', async () => {
    musicOn();
    const audio = new AudioManager();
    audio.unlock();
    music().rejectNextPlay = true;
    audio.playPrelude();
    await settle(); // the prelude is now queued for a retry
    audio.setMusicVolume(0);
    audio.playGame(); // what the game wants now, while music is off

    audio.unlock(); // a later gesture
    audio.setMusicVolume(1);
    expect(music().src).toContain('music/game.ogg');
    expect(music().loop).toBe(true);
  });
});
