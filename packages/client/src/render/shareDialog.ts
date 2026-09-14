/**
 * shareDialog.ts — the Share panel the solo screen opens after a game: the
 * message, the browser's own share sheet where it has one, Facebook, LinkedIn
 * and Bluesky links, and Copy. Esc, Close or a click on the backdrop closes
 * it. Wording and links are the pure `view/share.ts`. Only one is ever open.
 */

import { SOURCE_URL } from '@crack-attack/protocol';
import { shareLinks, shareMessage, type ShareInfo } from '../view/share.js';

const LINK_STYLE =
  'padding:6px 12px;border:1px solid #3a4356;border-radius:4px;background:#222838;' +
  'color:#d7dce5;text-decoration:none;font-size:14px';

/** Closes the open dialog, while one is open. */
let close: (() => void) | null = null;

/** Whether the dialog is open (the game should leave keys alone). */
export function shareDialogOpen(): boolean {
  return close !== null;
}

export function closeShareDialog(): void {
  close?.();
}

export function openShareDialog(info: ShareInfo): void {
  closeShareDialog();
  const links = shareLinks(info);
  const message = shareMessage(info);

  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(11,13,18,.85);font-family:system-ui,sans-serif;color:#d7dce5';

  const panel = document.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'share-title');
  panel.style.cssText =
    'display:flex;flex-direction:column;gap:12px;width:min(340px,calc(100vw - 48px));padding:22px;' +
    'background:#161a22;border:1px solid #2a3140;border-radius:8px';

  const title = document.createElement('strong');
  title.id = 'share-title';
  title.textContent = 'Share your score';
  title.style.fontSize = '15px';

  const text = document.createElement('p');
  text.textContent = message;
  text.style.cssText = 'margin:0;font-size:13px;opacity:.85;overflow-wrap:anywhere;user-select:all';

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  status.style.cssText = 'min-height:16px;font-size:12px;opacity:.8';

  // The browser's own share sheet (phones, mostly): any app, message included.
  if (typeof navigator.share === 'function') {
    actions.append(
      button('Share…', () => {
        navigator.share({ title: 'Crack Attack!', text: info.text, url: info.url }).catch(() => {
          // Dismissed, or refused: the other options are still here.
        });
      }),
    );
  }
  for (const [label, href] of [
    ['Facebook', links.facebook],
    ['LinkedIn', links.linkedin],
    ['Bluesky', links.bluesky],
  ] as const) {
    actions.append(link(label, href, LINK_STYLE));
  }
  actions.append(
    button('Copy message', () => {
      const copied = navigator.clipboard?.writeText(message);
      (copied ?? Promise.reject(new Error('no clipboard'))).then(
        () => (status.textContent = 'Copied!'),
        () => (status.textContent = "Couldn't copy: select the message above instead."),
      );
    }),
  );

  const source = document.createElement('span');
  source.style.cssText = 'font-size:12px;opacity:.7';
  source.append('Crack Attack! is open source: ', link('GitHub', SOURCE_URL, 'color:#9ab8ff'));

  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';
  const closeBtn = button('Close', () => finish());
  footer.append(source, closeBtn);

  panel.append(title, text, actions, status, footer);
  overlay.append(panel);

  // Focus stays inside, as in the other modals; Esc closes.
  const focusable = (): HTMLElement[] => Array.from(panel.querySelectorAll('a[href], button'));
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      finish();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusable();
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && i <= 0) {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (!e.shiftKey && i === items.length - 1) {
      e.preventDefault();
      items[0]?.focus();
    }
  };
  document.addEventListener('keydown', onKeyDown);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) {
      e.preventDefault();
      finish();
    }
  });

  function finish(): void {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
    close = null;
  }
  close = finish;

  document.body.appendChild(overlay);
  focusable()[0]?.focus();
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.style.cssText = 'padding:6px 12px;cursor:pointer';
  b.onclick = onClick;
  return b;
}

/** A link that opens in a new tab, so the game stays put. */
function link(label: string, href: string, style: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label;
  a.style.cssText = style;
  return a;
}
