/**
 * sharePage.ts — the page a shared run's link points at
 * (`GET /api/solo/share/:id`, see protocol `scoreboard.ts`). Link previews on
 * Facebook, LinkedIn, Bluesky and the like read its Open Graph tags, so the
 * card shows the run's score and places; they don't run scripts. A person
 * opening the link is sent straight on to the game, with a Play link in case
 * the script doesn't run.
 */

import { createHash } from 'node:crypto';
import { GC_STEPS_PER_SECOND } from '@crack-attack/core';
import { SOURCE_URL } from '@crack-attack/protocol';
import type { ShareCard } from './scoreboard.js';

const GAME_NAME = 'Crack Attack!';
const PITCH = 'The classic block-matching game, free in your browser.';
/** The link-preview image (`packages/client/public/og-image.png`) and its size. */
const CARD_IMAGE = { path: 'og-image.png', width: 1200, height: 630 };
const LOGO_PATH = 'textures/logo.png';
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Sends a person on to the game. It reads the Play link, so the script (and its hash) never changes. */
const REDIRECT_SCRIPT = "location.replace(document.getElementById('play').href)";
const REDIRECT_HASH = createHash('sha256').update(REDIRECT_SCRIPT).digest('base64');

/**
 * The page's Content-Security-Policy: its own inline style, its one script,
 * and images from the game's origin; nothing else.
 */
export function sharePageCsp(gameUrl: string): string {
  return [
    "default-src 'none'",
    `img-src ${new URL(gameUrl).origin}`,
    "style-src 'unsafe-inline'",
    `script-src 'sha256-${REDIRECT_HASH}'`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * A run's places, best chain and length, e.g.
 * "#3 of 120 in September 2026 · #15 of 900 all time · x6 chain · 1:36".
 */
export function shareSummary(card: ShareCard): string {
  const { entry, standing } = card;
  const parts: string[] = [];
  if (standing.month) {
    parts.push(`#${standing.month.rank} of ${standing.month.total} in ${monthName(card.month)}`);
  }
  if (standing.all) parts.push(`#${standing.all.rank} of ${standing.all.total} all time`);
  if (entry.topMultiplier > 1) parts.push(`x${entry.topMultiplier} chain`);
  parts.push(playTime(entry.ticks));
  return parts.join(' · ');
}

/**
 * The share page for `card`; null (an unknown or hidden run) gets a plain card
 * for the game. `gameUrl` is the game's address, ending in `/`.
 */
export function renderSharePage(card: ShareCard | null, gameUrl: string): string {
  const title = card ? `${card.entry.name} scored ${card.entry.score} in ${GAME_NAME}` : GAME_NAME;
  const description = card ? `${shareSummary(card)}. ${PITCH}` : PITCH;
  // The name is isolated, so a right-to-left one can't reorder the heading.
  const heading = card
    ? `<bdi>${esc(card.entry.name)}</bdi> scored ${card.entry.score} in ${GAME_NAME}`
    : GAME_NAME;
  const game = esc(gameUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${GAME_NAME}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(gameUrl + CARD_IMAGE.path)}">
<meta property="og:image:width" content="${CARD_IMAGE.width}">
<meta property="og:image:height" content="${CARD_IMAGE.height}">
<meta property="og:image:alt" content="${GAME_NAME}">
<meta name="twitter:card" content="summary_large_image">
<style>
html{color-scheme:dark;background:#0b0d12;color:#d7dce5;font-family:system-ui,sans-serif}
main{max-width:520px;margin:10vh auto;padding:0 16px;text-align:center}
h1{font-size:22px}
a{color:#9ab8ff}
#play{display:inline-block;margin:8px 0;padding:10px 20px;border-radius:6px;background:#2a4a8f;color:#fff;font-weight:700;text-decoration:none}
.small{font-size:13px;opacity:.75}
</style>
</head>
<body>
<main>
<img src="${esc(gameUrl + LOGO_PATH)}" alt="" width="160" height="160">
<h1>${heading}</h1>
<p>${esc(description)}</p>
<p><a id="play" href="${game}">Play ${GAME_NAME}</a></p>
<p class="small"><a href="${game}?scores">High scores</a> · <a href="${SOURCE_URL}">Source on GitHub</a></p>
</main>
<script>${REDIRECT_SCRIPT}</script>
</body>
</html>
`;
}

/** `YYYY-MM` as "September 2026". */
function monthName(key: string): string {
  const [year, month] = key.split('-');
  return `${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

/** A run's length as m:ss. */
function playTime(ticks: number): string {
  const seconds = Math.floor(ticks / GC_STEPS_PER_SECOND);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text or an attribute value, safe to put in the page. */
function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}
