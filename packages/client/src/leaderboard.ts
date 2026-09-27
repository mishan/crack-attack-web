/**
 * leaderboard.ts — the ladder screen: settled ratings, best first, and a
 * player's page (rating, record, recent rated games) a click away. Opened
 * from the lobby or the account screen, or with `?ladder` (`?ladder=<handle>`
 * opens a player's page); its own chunk, like High scores. Formatting is the
 * pure `view/rating.ts`.
 */

import {
  LEADERBOARD_MAX_LIMIT,
  SOURCE_URL,
  type LeaderboardResponse,
  type RatingPlayerResponse,
} from '@crack-attack/protocol';
import { AccountClient, AccountError, apiOriginFor } from './account/accountApi.js';
import { AccountState, browserStorage } from './account/accountState.js';
import { BitmapLabel } from './render/bitmapText.js';
import { FONT0 } from './view/bitmapFont.js';
import {
  GAME_COLUMNS,
  LADDER_COLUMNS,
  gameCells,
  ladderCells,
  ratingText,
  recordText,
} from './view/rating.js';

/** Show the screen; `onBack` leaves it (Back, or Esc from the ladder itself). */
export function bootLeaderboard(
  relayUrl: string,
  onBack: () => void,
  initialPlayer: string | null = null,
): { dispose(): void } {
  const origin = apiOriginFor(relayUrl);
  const client = origin === null ? null : new AccountClient(origin);
  const own = new AccountState(browserStorage()).handle;
  /** Bumped per load, so a slow response can't overwrite a newer view's. */
  let request = 0;
  let disposed = false;
  /** The player page on show, if any; Esc and Back go from it to the ladder. */
  let player: string | null = null;

  const root = document.createElement('div');
  root.style.cssText =
    'position:fixed;inset:0;z-index:10;overflow:auto;background:#0b0d12;color:#d7dce5;' +
    'font-family:system-ui,sans-serif';
  const column = document.createElement('div');
  column.style.cssText =
    'max-width:560px;margin:0 auto;padding:64px 16px 48px;display:flex;flex-direction:column;gap:14px';
  root.append(column);

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px';
  const title = new BitmapLabel(FONT0, { height: 26, color: '#e7ebf3' });
  title.setText('LEADERBOARD');
  title.element.setAttribute('role', 'heading');
  title.element.setAttribute('aria-label', 'Leaderboard');
  const back = button('Back', () => goBack());
  header.append(title.element, back);

  const find = document.createElement('form');
  find.style.cssText = 'display:flex;gap:6px';
  const findInput = document.createElement('input');
  findInput.placeholder = 'Find a player';
  findInput.maxLength = 32;
  findInput.style.cssText = 'flex:1;min-width:0;padding:6px';
  const findBtn = document.createElement('button');
  findBtn.type = 'submit';
  findBtn.textContent = 'Find';
  findBtn.style.cssText = 'padding:6px 12px;cursor:pointer';
  find.append(findInput, findBtn);
  find.onsubmit = (e): void => {
    e.preventDefault();
    const handle = findInput.value.trim();
    if (handle) void showPlayer(handle);
  };

  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  status.style.cssText = 'min-height:18px;opacity:.8;font-size:14px';
  const content = document.createElement('div');
  content.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  column.append(header, find, status, content, sourceLine());
  document.body.append(root);

  const goBack = (): void => {
    if (player !== null && initialPlayer === null) void showLadder();
    else onBack();
  };

  const load = async <T>(fetchIt: (c: AccountClient) => Promise<T>): Promise<T | null> => {
    const mine = ++request;
    content.replaceChildren();
    if (!client) {
      status.textContent = "The leaderboard isn't available here.";
      return null;
    }
    status.textContent = 'Loading…';
    try {
      const res = await fetchIt(client);
      return !disposed && mine === request ? res : null;
    } catch (err) {
      if (!disposed && mine === request) {
        status.textContent =
          err instanceof AccountError && err.code === 'not_found'
            ? 'No player by that handle.'
            : "Can't reach the leaderboard right now.";
      }
      return null;
    }
  };

  const showLadder = async (): Promise<void> => {
    player = null;
    initialPlayer = null;
    const res = await load((c) => c.leaderboard(LEADERBOARD_MAX_LIMIT));
    if (res) renderLadder(res);
  };

  const showPlayer = async (handle: string): Promise<void> => {
    player = handle;
    const res = await load((c) => c.player(handle));
    if (res) renderPlayer(res);
  };

  const renderLadder = (res: LeaderboardResponse): void => {
    status.textContent =
      res.entries.length === 0
        ? 'No settled ratings yet: a rating joins the ladder after a few rated games.'
        : 'Settled ratings with a rated game in the last 30 days.';
    if (res.entries.length === 0) return;
    const table = makeTable(LADDER_COLUMNS);
    const body = table.createTBody();
    for (const entry of res.entries) {
      const tr = body.insertRow();
      if (own !== null && entry.handle === own) {
        tr.style.background = '#1f2b45';
        tr.title = 'you';
      }
      ladderCells(entry).forEach((text, i) => {
        const col = LADDER_COLUMNS[i]!;
        const cell = tr.insertCell();
        styleCell(cell, col.align);
        if ('isolate' in col) {
          cell.dir = 'auto';
          cell.append(linkButton(text, () => void showPlayer(entry.handle)));
        } else {
          cell.textContent = text;
        }
      });
    }
    content.replaceChildren(table);
  };

  const renderPlayer = (res: RatingPlayerResponse): void => {
    status.textContent = '';
    const name = document.createElement('h2');
    name.textContent = res.handle;
    name.dir = 'auto';
    name.style.cssText = 'margin:0;font-size:18px';
    const facts = document.createElement('p');
    facts.style.cssText = 'margin:0;opacity:.9';
    facts.textContent =
      `Rating ${ratingText(res)}${res.provisional ? ' (provisional)' : ''} · ` +
      `record ${recordText(res)}`;
    const parts: Node[] = [name, facts];
    if (res.games.length === 0) {
      parts.push(document.createTextNode('No rated games yet.'));
    } else {
      const table = makeTable(GAME_COLUMNS);
      const body = table.createTBody();
      for (const game of res.games) {
        const tr = body.insertRow();
        gameCells(game).forEach((text, i) => {
          const col = GAME_COLUMNS[i]!;
          const cell = tr.insertCell();
          styleCell(cell, col.align);
          if ('isolate' in col && game.opponent !== null) {
            cell.dir = 'auto';
            const opponent = game.opponent;
            cell.append(linkButton(text, () => void showPlayer(opponent)));
          } else {
            cell.textContent = text;
          }
        });
      }
      parts.push(table);
    }
    parts.push(row(button('All players', () => void showLadder())));
    content.replaceChildren(...parts);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      goBack();
    }
  };
  globalThis.addEventListener('keydown', onKeyDown);
  if (initialPlayer !== null) void showPlayer(initialPlayer);
  else void showLadder();
  back.focus();

  return {
    dispose(): void {
      disposed = true;
      globalThis.removeEventListener('keydown', onKeyDown);
      root.remove();
    },
  };
}

function makeTable(columns: readonly { label: string; align: string }[]): HTMLTableElement {
  const table = document.createElement('table');
  table.style.cssText =
    'width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums';
  const head = table.createTHead().insertRow();
  for (const col of columns) {
    const th = document.createElement('th');
    th.textContent = col.label;
    th.style.cssText = `text-align:${col.align};padding:6px 8px;opacity:.7;font-weight:600;border-bottom:1px solid #2a3140`;
    head.append(th);
  }
  return table;
}

function styleCell(cell: HTMLTableCellElement, align: string): void {
  cell.style.cssText = `text-align:${align};padding:5px 8px;border-bottom:1px solid #1a1f29;white-space:nowrap`;
}

/** A button that looks like a link: a handle that opens its player page. */
function linkButton(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.style.cssText =
    'background:none;border:none;padding:0;color:#9ab8ff;cursor:pointer;font:inherit;text-align:inherit';
  b.onclick = onClick;
  return b;
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

function row(...nodes: Node[]): HTMLDivElement {
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
  div.append(...nodes);
  return div;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.style.cssText = 'padding:6px 12px;cursor:pointer';
  b.onclick = onClick;
  return b;
}
