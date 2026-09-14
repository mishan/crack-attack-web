import { describe, expect, it } from 'vitest';
import type { SoloSubmitResponse } from '@crack-attack/protocol';
import { gameUrlFor, shareInfo, shareLinks, shareMessage } from './share.js';

const GAME = 'https://game.example/';
const API = 'https://game.example/api/solo';

const verified = (month: SoloSubmitResponse['standing']['month']): SoloSubmitResponse => ({
  id: 42,
  name: 'misha',
  score: 1234,
  topMultiplier: 4,
  ticks: 3000,
  standing: { all: { rank: 9, total: 50 }, month },
});

describe('shareInfo', () => {
  it("links a verified run's share page, with its place this month", () => {
    expect(shareInfo(1234, verified({ rank: 3, total: 20 }), GAME, API)).toEqual({
      text: 'I scored 1234 in Crack Attack! #3 this month. Can you beat it?',
      url: 'https://game.example/api/solo/share/42',
    });
    expect(shareInfo(1234, verified(null), GAME, API).text).toBe(
      'I scored 1234 in Crack Attack! Can you beat it?',
    );
  });

  it("links the game for a run the scoreboard hasn't verified", () => {
    expect(shareInfo(77, null, GAME, API)).toEqual({
      text: 'I scored 77 in Crack Attack! Can you beat it?',
      url: GAME,
    });
    expect(shareInfo(77, verified(null), GAME, null).url).toBe(GAME);
  });
});

describe('shareLinks', () => {
  it('gives Facebook and LinkedIn the link alone, and Bluesky the whole message', () => {
    const info = { text: 'I scored 5 & more!', url: 'https://g.example/api/solo/share/1' };
    const links = shareLinks(info);
    expect(links.facebook).toBe(
      'https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fg.example%2Fapi%2Fsolo%2Fshare%2F1',
    );
    expect(links.linkedin).toBe(
      'https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fg.example%2Fapi%2Fsolo%2Fshare%2F1',
    );
    expect(new URL(links.bluesky).searchParams.get('text')).toBe(shareMessage(info));
    expect(shareMessage(info)).toBe('I scored 5 & more! https://g.example/api/solo/share/1');
  });
});

describe('gameUrlFor', () => {
  it("prefers the build's address, else this page without its query", () => {
    const here = { origin: 'https://example.com', pathname: '/games/ca/' };
    expect(gameUrlFor('https://c-a.example', here)).toBe('https://c-a.example/');
    expect(gameUrlFor('https://c-a.example/', here)).toBe('https://c-a.example/');
    expect(gameUrlFor(undefined, here)).toBe('https://example.com/games/ca/');
    expect(gameUrlFor('', here)).toBe('https://example.com/games/ca/');
  });
});
