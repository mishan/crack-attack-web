/**
 * namePrompt.ts — asks for a name the first time a ranked run is submitted
 * (the boards are public), prefilled with any name saved in the lobby.
 * Resolves to the cleaned-up name, or null if the player chose not to submit
 * the run. There's no dismiss-by-Escape or backdrop click: dropping a finished
 * run takes the explicit "Don't submit". Only one prompt is ever open: asking
 * again while it is gets the same answer.
 */

import {
  SCORE_NAME_MAX_INPUT,
  SCORE_NAME_MAX_LENGTH,
  normalizeScoreName,
} from '@crack-attack/protocol';

/** The open prompt's answer, while one is open. */
let open: Promise<string | null> | null = null;

/** Whether the prompt is open (the game should leave keys alone). */
export function namePromptOpen(): boolean {
  return open !== null;
}

export function promptScoreName(prefill = ''): Promise<string | null> {
  open ??= showPrompt(prefill).finally(() => {
    open = null;
  });
  return open;
}

function showPrompt(prefill: string): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(11,13,18,.85);font-family:system-ui,sans-serif;color:#d7dce5';

    const panel = document.createElement('form');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'score-name-title');
    panel.style.cssText =
      'display:flex;flex-direction:column;gap:10px;width:300px;padding:22px;' +
      'background:#161a22;border:1px solid #2a3140;border-radius:8px';

    const title = document.createElement('strong');
    title.id = 'score-name-title';
    title.textContent = 'Your name for the high scores';
    title.style.fontSize = '15px';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = prefill;
    // A right-to-left name reads (and edits) in its own direction.
    input.dir = 'auto';
    input.setAttribute('autocomplete', 'nickname');
    input.placeholder = 'name';
    // An emoji or flag takes several UTF-16 units: allow what the server reads,
    // and let the cleanup trim to SCORE_NAME_MAX_LENGTH characters.
    input.maxLength = SCORE_NAME_MAX_INPUT;
    input.setAttribute('aria-labelledby', 'score-name-title');
    input.setAttribute('aria-describedby', 'score-name-hint');
    input.style.cssText = 'padding:8px 10px;font-size:15px';

    const hint = document.createElement('span');
    hint.id = 'score-name-hint';
    hint.textContent = `Shown on the public boards, up to ${SCORE_NAME_MAX_LENGTH} characters.`;
    hint.style.cssText = 'font-size:12px;opacity:.7';

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.textContent = "Don't submit";
    skip.style.cssText = 'opacity:.8;cursor:pointer';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Submit';
    submit.style.cssText = 'font-weight:700;cursor:pointer';
    buttons.append(skip, submit);

    // Focus management, as the other modals: remember the opener, keep Tab
    // inside the dialog, and give focus back on close.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = [input, skip, submit];
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const i = focusable.indexOf(document.activeElement as HTMLInputElement | HTMLButtonElement);
      if (e.shiftKey && i === 0) {
        e.preventDefault();
        submit.focus();
      } else if (!e.shiftKey && i === focusable.length - 1) {
        e.preventDefault();
        input.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    // A click on the backdrop or the panel's text would otherwise move focus
    // out to the page, where keys would reach the game again.
    overlay.addEventListener('mousedown', (e) => {
      if (!focusable.some((el) => el.contains(e.target as Node))) e.preventDefault();
    });

    const finish = (name: string | null): void => {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      if (opener?.isConnected) opener.focus();
      resolve(name);
    };
    panel.onsubmit = (e) => {
      e.preventDefault();
      const name = normalizeScoreName(input.value);
      if (name === null) {
        hint.textContent = 'Enter a name to submit the run.';
        input.focus();
        return;
      }
      finish(name);
    };
    skip.onclick = () => finish(null);

    panel.append(title, input, hint, buttons);
    overlay.append(panel);
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}
