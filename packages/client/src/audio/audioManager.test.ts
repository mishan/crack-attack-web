import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioManager } from './audioManager.js';

/** Just enough HTMLAudioElement for the music path. */
class FakeAudio {
  src = '';
  loop = false;
  volume = 1;
  preload = '';
  paused = true;
  play(): Promise<void> {
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
});
