import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SOURCE_URL } from '@crack-attack/protocol';
import type { ShareCard } from './scoreboard.js';
import { renderSharePage, sharePageCsp, shareSummary } from './sharePage.js';

const GAME = 'https://game.example/';

const card = (
  over: Partial<ShareCard['entry']> = {},
  standing: ShareCard['standing'] = {
    all: { rank: 15, total: 900 },
    month: { rank: 3, total: 120 },
  },
): ShareCard => ({
  entry: {
    id: 7,
    name: 'misha',
    score: 12345,
    topMultiplier: 6,
    ticks: 4800,
    createdAt: Date.UTC(2026, 8, 13),
    ...over,
  },
  month: '2026-09',
  standing,
});

/** The content of a page's `<meta property|name="key">`. */
function meta(html: string, key: string): string | undefined {
  const tag = new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(html);
  return tag?.[1];
}

describe('shareSummary', () => {
  it('gives the places, best chain and length', () => {
    expect(shareSummary(card())).toBe(
      '#3 of 120 in September 2026 · #15 of 900 all time · x6 chain · 1:36',
    );
  });

  it('leaves out places the run no longer has, and a chain it never made', () => {
    expect(shareSummary(card({ topMultiplier: 1, ticks: 2757 }, { all: null, month: null }))).toBe(
      '0:55',
    );
  });
});

describe('renderSharePage', () => {
  it('puts the score in the link preview, with an absolute image URL', () => {
    const html = renderSharePage(card(), GAME);
    expect(meta(html, 'og:title')).toBe('misha scored 12345 in Crack Attack!');
    expect(meta(html, 'og:description')).toBe(
      '#3 of 120 in September 2026 · #15 of 900 all time · x6 chain · 1:36. ' +
        'The classic block-matching game, free in your browser.',
    );
    expect(meta(html, 'og:image')).toBe('https://game.example/og-image.png');
    expect(meta(html, 'twitter:card')).toBe('summary_large_image');
    expect(html).toContain('<title>misha scored 12345 in Crack Attack!</title>');
    expect(html).toContain('<a id="play" href="https://game.example/">');
    expect(html).toContain(`<a href="${SOURCE_URL}">`);
  });

  it("escapes the player's name everywhere it appears", () => {
    const html = renderSharePage(card({ name: `<script>"x"&'` }), GAME);
    expect(html).not.toContain('<script>"');
    expect(meta(html, 'og:title')).toBe(
      '&lt;script&gt;&quot;x&quot;&amp;&#39; scored 12345 in Crack Attack!',
    );
    expect(html).toContain('<bdi>&lt;script&gt;&quot;x&quot;&amp;&#39;</bdi>');
  });

  it('gives a run it does not show a plain card for the game', () => {
    const html = renderSharePage(null, GAME);
    expect(meta(html, 'og:title')).toBe('Crack Attack!');
    expect(html).toContain('<title>Crack Attack!</title>');
  });

  it("allows exactly the page's own script, and images from the game", () => {
    const html = renderSharePage(card(), GAME);
    const start = html.indexOf('<script>') + '<script>'.length;
    const script = html.slice(start, html.indexOf('</script>', start));
    const hash = createHash('sha256').update(script).digest('base64');
    const csp = sharePageCsp(GAME);
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
    expect(csp).toContain('img-src https://game.example;');
    expect(csp).toContain("default-src 'none'");
  });
});
