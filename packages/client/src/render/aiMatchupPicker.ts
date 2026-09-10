/**
 * aiMatchupPicker.ts — a small modal to choose the two bots for the AI-vs-AI
 * demo. Resolves to the chosen pairing, or null if cancelled. Same dialog shell
 * as `pickAiDifficulty`: focus trap, Escape / backdrop / Cancel dismiss.
 */

import type { AiDifficultyLevel } from '@crack-attack/core';

/** Which tier plays each board. */
export interface AiMatchup {
  readonly left: AiDifficultyLevel;
  readonly right: AiDifficultyLevel;
}

const TIERS: { id: AiDifficultyLevel; label: string }[] = [
  { id: 'easy', label: 'Easy' },
  { id: 'medium', label: 'Medium' },
  { id: 'hard', label: 'Hard' },
];

export function pickAiMatchup(initial: AiMatchup): Promise<AiMatchup | null> {
  return new Promise((resolve) => {
    let left = initial.left;
    let right = initial.right;

    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(11,13,18,.85);font-family:system-ui,sans-serif;color:#d7dce5';

    const panel = document.createElement('div');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'ai-matchup-title');
    panel.style.cssText =
      'display:flex;flex-direction:column;gap:10px;width:320px;padding:22px;' +
      'background:#161a22;border:1px solid #2a3140;border-radius:8px';

    const title = document.createElement('strong');
    title.id = 'ai-matchup-title';
    title.textContent = 'Watch AI vs AI — pick the bots';
    title.style.fontSize = '15px';
    panel.append(title);

    // One row of toggle buttons per board; aria-pressed marks the selection.
    const addRow = (
      name: string,
      get: () => AiDifficultyLevel,
      set: (d: AiDifficultyLevel) => void,
    ) => {
      const row = document.createElement('div');
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', `${name} bot`);
      row.style.cssText = 'display:flex;align-items:center;gap:6px';
      const label = document.createElement('span');
      label.textContent = name;
      label.style.cssText = 'width:44px;opacity:.75;font-size:13px';
      row.append(label);
      const buttons = TIERS.map((tier) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = tier.label;
        btn.style.cssText = 'flex:1;padding:8px 0;cursor:pointer';
        btn.onclick = () => {
          set(tier.id);
          sync();
        };
        row.append(btn);
        return { id: tier.id, btn };
      });
      const sync = (): void => {
        for (const { id, btn } of buttons) {
          const on = id === get();
          btn.setAttribute('aria-pressed', String(on));
          btn.style.outline = on ? '2px solid #7aa2ff' : 'none';
          btn.style.fontWeight = on ? '700' : '400';
        }
      };
      sync();
      panel.append(row);
    };
    addRow(
      'Left',
      () => left,
      (d) => (left = d),
    );
    addRow(
      'Right',
      () => right,
      (d) => (right = d),
    );

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
        return;
      }
      if (e.key === 'Tab') {
        const buttons = Array.from(panel.querySelectorAll('button'));
        if (buttons.length === 0) return;
        const first = buttons[0]!;
        const last = buttons[buttons.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);

    const finish = (value: AiMatchup | null): void => {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      opener?.focus();
      resolve(value);
    };

    const watch = document.createElement('button');
    watch.type = 'button';
    watch.textContent = 'Watch';
    watch.style.cssText = 'margin-top:6px;padding:10px 12px;font-weight:700;cursor:pointer';
    watch.onclick = () => finish({ left, right });
    panel.append(watch);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'opacity:.8;cursor:pointer';
    cancel.onclick = () => finish(null);
    panel.append(cancel);

    overlay.onclick = (e) => {
      if (e.target === overlay) finish(null);
    };

    overlay.append(panel);
    document.body.appendChild(overlay);
    // Focus "Watch" so Enter starts the default matchup straight away.
    watch.focus();
  });
}
