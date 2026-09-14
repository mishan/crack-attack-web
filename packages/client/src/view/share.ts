/**
 * share.ts — pure wording and links for sharing a finished solo run: the
 * message, the link, and each network's share URL. Once the scoreboard has
 * verified a ranked run, the link is the run's share page, whose preview
 * shows the score; otherwise it's the game. Facebook and LinkedIn take only
 * the link (their previews come from its Open Graph tags), so the message
 * itself rides along only on Bluesky, the native share sheet and Copy.
 */

import { soloSharePath, type SoloSubmitResponse } from '@crack-attack/protocol';

export interface ShareInfo {
  /** The message, without the link. */
  text: string;
  url: string;
}

export interface ShareLinks {
  facebook: string;
  linkedin: string;
  bluesky: string;
}

/**
 * What a finished run shares. `verified` is the scoreboard's answer for a
 * ranked run; `scoreboardUrl` is the scoreboard's base URL, null without one.
 */
export function shareInfo(
  score: number,
  verified: SoloSubmitResponse | null,
  gameUrl: string,
  scoreboardUrl: string | null,
): ShareInfo {
  if (verified && scoreboardUrl) {
    const month = verified.standing.month;
    const place = month ? ` #${month.rank} this month.` : '';
    return {
      text: `I scored ${verified.score} in Crack Attack!${place} Can you beat it?`,
      url: scoreboardUrl + soloSharePath(verified.id),
    };
  }
  return { text: `I scored ${score} in Crack Attack! Can you beat it?`, url: gameUrl };
}

/** The message followed by its link: for Bluesky and the clipboard. */
export function shareMessage({ text, url }: ShareInfo): string {
  return `${text} ${url}`;
}

export function shareLinks(info: ShareInfo): ShareLinks {
  const url = encodeURIComponent(info.url);
  return {
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${url}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
    bluesky: `https://bsky.app/intent/compose?text=${encodeURIComponent(shareMessage(info))}`,
  };
}

/**
 * The game's address, to share: the build's `VITE_PUBLIC_URL`, else this
 * page's without its query (`?solo` and the like).
 */
export function gameUrlFor(
  configured: string | undefined,
  location: { origin: string; pathname: string },
): string {
  if (configured) return configured.endsWith('/') ? configured : `${configured}/`;
  return location.origin + location.pathname;
}
