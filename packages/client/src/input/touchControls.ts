/**
 * touchControls.ts
 *
 * On-screen controls for touch / coarse-pointer devices (phones, tablets). They
 * drive the *same* input path as the keyboard: each button presses and releases
 * a `KeyboardEvent.code` on the shared {@link KeyboardInput} (see `DEFAULT_KEYMAP`),
 * so the sim sees identical held-command state whether it came from a key or a
 * thumb. A button holds its command from `pointerdown` until `pointerup` — just
 * like a key. So a *tap* on a direction moves once (the swapper needs a fresh
 * press to move again), while *holding* Raise keeps the stack rising.
 *
 * The overlay only mounts on devices with a coarse pointer, so desktop stays
 * keyboard-only and uncluttered. The button wiring is unit-tested with a small
 * DOM stub (`touchControls.test.ts`); Pointer Events unify touch and mouse.
 */

/** The commands a control button can hold, as `KeyboardInput` codes. */
export interface TouchControlSink {
  press(code: string): void;
  release(code: string): void;
  restart(): void;
}

/** Whether this device wants on-screen controls (touch / coarse pointer). */
export function prefersTouchControls(): boolean {
  const coarse = globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;
  const touch = (globalThis.navigator?.maxTouchPoints ?? 0) > 0;
  return coarse || touch;
}

const CSS = `
.touch-controls {
  position: fixed;
  inset: auto 0 0 0;
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  padding: 18px max(18px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom))
    max(18px, env(safe-area-inset-left));
  pointer-events: none;
  z-index: 10;
  user-select: none;
  -webkit-user-select: none;
}
.touch-controls button {
  pointer-events: auto;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  border: 1px solid rgba(215, 220, 229, 0.25);
  background: rgba(30, 34, 44, 0.55);
  color: #d7dce5;
  border-radius: 14px;
  font: 600 20px/1 system-ui, sans-serif;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(2px);
}
.touch-controls button.pressed {
  background: rgba(90, 110, 150, 0.75);
  border-color: rgba(215, 220, 229, 0.6);
}
.touch-dpad {
  display: grid;
  grid-template-columns: repeat(3, 58px);
  grid-template-rows: repeat(3, 58px);
  gap: 8px;
}
.touch-dpad .up { grid-area: 1 / 2; }
.touch-dpad .left { grid-area: 2 / 1; }
.touch-dpad .right { grid-area: 2 / 3; }
.touch-dpad .down { grid-area: 3 / 2; }
.touch-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
}
.touch-actions .row { display: flex; gap: 12px; align-items: flex-end; }
.touch-actions .swap { width: 92px; height: 78px; font-size: 22px; }
.touch-actions .raise { width: 92px; height: 58px; font-size: 15px; }
.touch-actions .restart {
  width: 46px; height: 46px; font-size: 18px; border-radius: 50%;
  background: rgba(30, 34, 44, 0.4);
}
`;

/** Build one control button that holds `code` (or fires `onTap`) while pressed. */
function makeButton(
  label: string,
  className: string,
  onDown: () => void,
  onUp: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button'; // never a form-submit button, even if mounted over a form
  btn.className = className;
  btn.textContent = label;
  btn.setAttribute('aria-label', className.split(' ').pop() ?? label);

  const down = (e: PointerEvent): void => {
    e.preventDefault();
    btn.classList.add('pressed');
    // Keep receiving the pointerup even if the thumb slides off the button.
    if (e.pointerId !== undefined) btn.setPointerCapture?.(e.pointerId);
    onDown();
  };
  const up = (e: PointerEvent): void => {
    e.preventDefault();
    btn.classList.remove('pressed');
    onUp();
  };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  // Suppress the long-press context menu on mobile.
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  return btn;
}

/**
 * Mount the on-screen controls into `document.body` (only on touch devices) and
 * wire them to `sink`. Returns the root element (or null if not mounted).
 */
export function mountTouchControls(sink: TouchControlSink): HTMLElement | null {
  if (!prefersTouchControls()) return null;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'touch-controls';

  // D-pad: one button per direction (no diagonals — the swapper ignores them).
  const dpad = document.createElement('div');
  dpad.className = 'touch-dpad';
  const hold =
    (code: string) =>
    (press: boolean): void =>
      press ? sink.press(code) : sink.release(code);
  const dirs: Array<[string, string, string]> = [
    ['▲', 'up', 'ArrowUp'],
    ['◀', 'left', 'ArrowLeft'],
    ['▶', 'right', 'ArrowRight'],
    ['▼', 'down', 'ArrowDown'],
  ];
  for (const [label, cls, code] of dirs) {
    const h = hold(code);
    dpad.appendChild(
      makeButton(
        label,
        cls,
        () => h(true),
        () => h(false),
      ),
    );
  }

  // Actions: Swap (Space), Raise (hold to keep rising), and Restart.
  const actions = document.createElement('div');
  actions.className = 'touch-actions';
  const swapHold = hold('Space');
  const raiseHold = hold('KeyX');
  const swap = makeButton(
    'Swap',
    'swap',
    () => swapHold(true),
    () => swapHold(false),
  );
  const raise = makeButton(
    'Raise',
    'raise',
    () => raiseHold(true),
    () => raiseHold(false),
  );
  const restart = makeButton(
    '↻',
    'restart',
    () => sink.restart(),
    () => {},
  );
  const row = document.createElement('div');
  row.className = 'row';
  row.append(restart, swap);
  actions.append(row, raise);

  root.append(dpad, actions);
  document.body.appendChild(root);
  return root;
}
