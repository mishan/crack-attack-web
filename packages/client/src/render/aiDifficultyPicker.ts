/**
 * aiDifficultyPicker.ts — a small modal to choose the AI difficulty before a
 * vs-AI match. Resolves to the chosen {@link AiDifficulty}, or null if cancelled.
 */

import type { AiDifficulty } from '@crack-attack/core';

const OPTIONS: { id: AiDifficulty; label: string; blurb: string }[] = [
  { id: 'easy', label: 'Easy', blurb: 'attacks slowly · small capacity' },
  { id: 'medium', label: 'Medium', blurb: 'steady pressure' },
  { id: 'hard', label: 'Hard', blurb: 'fast attacks · big capacity' },
];

export function pickAiDifficulty(): Promise<AiDifficulty | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(11,13,18,.85);font-family:system-ui,sans-serif;color:#d7dce5';

    const panel = document.createElement('div');
    panel.style.cssText =
      'display:flex;flex-direction:column;gap:10px;width:300px;padding:22px;' +
      'background:#161a22;border:1px solid #2a3140;border-radius:8px';

    const title = document.createElement('strong');
    title.textContent = 'Play vs AI — choose difficulty';
    title.style.fontSize = '15px';
    panel.append(title);

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null); // Escape dismisses the dialog, like the backdrop/Cancel
      }
    };
    document.addEventListener('keydown', onKeyDown);

    const finish = (value: AiDifficulty | null): void => {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      resolve(value);
    };

    for (const opt of OPTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.cssText = 'text-align:left;padding:10px 12px;cursor:pointer';
      // Build nodes with textContent rather than innerHTML: no HTML-injection
      // surface, even if a label/blurb ever becomes dynamic.
      const label = document.createElement('strong');
      label.textContent = opt.label;
      const blurb = document.createElement('span');
      blurb.style.cssText = 'opacity:.65;font-size:12px';
      blurb.textContent = ` — ${opt.blurb}`;
      btn.append(label, blurb);
      btn.onclick = () => finish(opt.id);
      panel.append(btn);
    }

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'margin-top:4px;opacity:.8;cursor:pointer';
    cancel.onclick = () => finish(null);
    panel.append(cancel);

    overlay.onclick = (e) => {
      if (e.target === overlay) finish(null); // click the backdrop to cancel
    };

    overlay.append(panel);
    document.body.appendChild(overlay);
  });
}
