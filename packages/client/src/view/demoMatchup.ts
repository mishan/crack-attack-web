/**
 * demoMatchup.ts — parse the `?demo=` URL value into the AI-vs-AI demo's bot
 * pairing. Pure (no DOM), so the URL contract is unit-tested.
 */

import type { AiDifficultyLevel } from '@crack-attack/core';
import type { AiMatchup } from '../render/aiMatchupPicker.js';

/** A tier name (case-insensitive, surrounding spaces ignored), or undefined if unknown. */
function parseTier(s: string | undefined): AiDifficultyLevel | undefined {
  const t = s?.trim().toLowerCase();
  return t === 'easy' || t === 'medium' || t === 'hard' ? t : undefined;
}

/**
 * `?demo=easy,hard` → easy (left) vs hard (right). A missing or unknown right
 * tier mirrors the left (`?demo=easy` and `?demo=easy,` are easy vs easy); a
 * missing or unknown left tier is hard, so a bare `?demo` is hard vs hard.
 */
export function parseDemoMatchup(value: string | null): AiMatchup {
  const [l, r] = (value ?? '').split(',');
  const left = parseTier(l) ?? 'hard';
  return { left, right: parseTier(r) ?? left };
}
