/**
 * highScores.ts — the high-score screen: the online solo scoreboard's boards
 * (score and chain multiplier; this month, last month, all time), with the
 * runs this browser submitted highlighted. Opened from the solo screen, or
 * with `?scores`; its own chunk, fetched when first opened. Formatting is the
 * pure `view/highScores.ts`.
 */

import { SOURCE_URL, type ScoreBoard, type SoloScoresResponse } from '@crack-attack/protocol';
import { BitmapLabel } from './render/bitmapText.js';
import type { ScoreboardClient } from './score/scoreboardApi.js';
import { loadOwnRuns } from './score/scoreStore.js';
import { FONT0 } from './view/bitmapFont.js';
import {
  HIGH_SCORE_COLUMNS,
  entryCells,
  periodQuery,
  type HighScorePeriod,
} from './view/highScores.js';

const BOARDS: { id: ScoreBoard; label: string }[] = [
  { id: 'score', label: 'Score' },
  { id: 'mult', label: 'Chain' },
];
const PERIODS: { id: HighScorePeriod; label: string }[] = [
  { id: 'month', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'all', label: 'All time' },
];

/** Show the screen; `onBack` leaves it (Back, or Esc). */
export function bootHighScores(
  client: ScoreboardClient | null,
  onBack: () => void,
): { dispose(): void } {
  let board: ScoreBoard = 'score';
  let period: HighScorePeriod = 'month';
  /** Bumped per load, so a slow response can't overwrite a newer tab's. */
  let request = 0;
  let disposed = false;

  const root = document.createElement('div');
  root.style.cssText =
    'position:fixed;inset:0;z-index:10;overflow:auto;background:#0b0d12;color:#d7dce5;' +
    'font-family:system-ui,sans-serif';
  // Top padding clears the audio controls, which stay pinned top right.
  const column = document.createElement('div');
  column.style.cssText =
    'max-width:560px;margin:0 auto;padding:64px 16px 48px;display:flex;flex-direction:column;gap:14px';
  root.append(column);

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px';
  const title = new BitmapLabel(FONT0, { height: 26, color: '#e7ebf3' });
  title.setText('HIGH SCORES');
  title.element.setAttribute('role', 'heading');
  title.element.setAttribute('aria-label', 'High scores');
  const back = button('Back', onBack);
  header.append(title.element, back);

  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  status.style.cssText = 'min-height:18px;opacity:.8;font-size:14px';
  const table = document.createElement('table');
  table.style.cssText =
    'width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums';

  const render = (res: SoloScoresResponse): void => {
    table.replaceChildren();
    if (res.entries.length === 0) {
      status.textContent = 'No runs yet — be the first!';
      return;
    }
    status.textContent = `${res.total} run${res.total === 1 ? '' : 's'}`;
    const own = loadOwnRuns();
    const head = table.createTHead().insertRow();
    for (const col of HIGH_SCORE_COLUMNS) {
      const th = document.createElement('th');
      th.textContent = col.label;
      th.style.cssText = `text-align:${col.align};padding:6px 8px;opacity:.7;font-weight:600;border-bottom:1px solid #2a3140`;
      head.append(th);
    }
    const body = table.createTBody();
    for (const entry of res.entries) {
      const row = body.insertRow();
      if (own.has(entry.id)) {
        row.style.background = '#1f2b45';
        row.title = 'your run';
      }
      entryCells(entry).forEach((text, i) => {
        const col = HIGH_SCORE_COLUMNS[i]!;
        const cell = row.insertCell();
        cell.textContent = text;
        if (col.isolate) cell.dir = 'auto';
        cell.style.cssText = `text-align:${col.align};padding:5px 8px;border-bottom:1px solid #1a1f29;white-space:nowrap`;
      });
    }
  };

  const load = async (): Promise<void> => {
    const mine = ++request;
    table.replaceChildren();
    if (!client) {
      status.textContent = "The online scoreboard isn't available here.";
      return;
    }
    status.textContent = 'Loading…';
    try {
      const res = await client.scores({ board, ...periodQuery(period, Date.now()) });
      if (!disposed && mine === request) render(res);
    } catch {
      if (!disposed && mine === request)
        status.textContent = "Can't reach the scoreboard right now.";
    }
  };

  /** A row of toggle buttons; picking one reloads the board. */
  const tabs = <T extends string>(
    label: string,
    options: { id: T; label: string }[],
    current: () => T,
    pick: (id: T) => void,
  ): HTMLElement => {
    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    group.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
    const buttons = options.map((opt) => {
      const b = button(opt.label, () => {
        pick(opt.id);
        sync();
        void load();
      });
      b.dataset['id'] = opt.id;
      return b;
    });
    const sync = (): void => {
      for (const b of buttons) {
        const on = b.dataset['id'] === current();
        b.setAttribute('aria-pressed', String(on));
        b.style.opacity = on ? '1' : '.6';
        b.style.fontWeight = on ? '700' : '400';
      }
    };
    sync();
    group.append(...buttons);
    return group;
  };

  column.append(
    header,
    tabs(
      'Board',
      BOARDS,
      () => board,
      (id) => (board = id),
    ),
    tabs(
      'Period',
      PERIODS,
      () => period,
      (id) => (period = id),
    ),
    status,
    table,
    sourceLine(),
  );
  document.body.append(root);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onBack();
    }
  };
  globalThis.addEventListener('keydown', onKeyDown);
  void load();
  back.focus();

  return {
    dispose(): void {
      disposed = true;
      globalThis.removeEventListener('keydown', onKeyDown);
      root.remove();
    },
  };
}

/** A footer line linking the source code. */
function sourceLine(): HTMLElement {
  const line = document.createElement('p');
  line.style.cssText = 'margin:12px 0 0;font-size:13px;opacity:.7;text-align:center';
  const a = document.createElement('a');
  a.href = SOURCE_URL;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'GitHub';
  a.style.color = '#9ab8ff';
  line.append('Crack Attack! is open source: ', a);
  return line;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.style.cssText = 'padding:6px 12px;cursor:pointer';
  b.onclick = onClick;
  return b;
}
