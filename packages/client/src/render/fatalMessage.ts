/**
 * fatalMessage.ts — the last-resort screen for when the game can't run: no
 * WebGL, a mode that fails to start, or the browser dropping the graphics
 * context mid-game. Plain DOM (no WebGL), so it works exactly when rendering
 * doesn't, and it replaces the "Loading…" placeholder rather than leaving a
 * blank page.
 */

export const NO_WEBGL_MESSAGE =
  "Crack Attack! needs WebGL 2, which this browser or device isn't providing. Try an " +
  'up-to-date Chrome, Firefox, Safari, or Edge, and check that hardware acceleration is ' +
  "turned on in the browser's settings.";

export const START_FAILED_MESSAGE =
  "Crack Attack! couldn't start its graphics. Reloading usually fixes this; if it keeps " +
  "happening, check that hardware acceleration is turned on in the browser's settings.";

export const CONTEXT_LOST_MESSAGE =
  "The browser reset the game's graphics (this can happen when a tab sits in the " +
  'background or the graphics driver restarts). Reload to keep playing.';

/** Whether this browser can give us a WebGL 2 context (three.js renders only with WebGL 2). */
export function webglAvailable(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    // Release the probe context now rather than waiting for GC — browsers cap them.
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return gl !== null;
  } catch {
    return false;
  }
}

/** Cover the page with `message` and a Reload button (idempotent: the latest message wins). */
export function showFatal(message: string): void {
  document.getElementById('loading')?.remove();
  let root = document.getElementById('fatal');
  if (!root) {
    root = document.createElement('div');
    root.id = 'fatal';
    root.setAttribute('role', 'alert');
    root.style.cssText =
      'position:fixed;inset:0;z-index:100;display:flex;flex-direction:column;gap:16px;' +
      'align-items:center;justify-content:center;padding:24px;text-align:center;' +
      'background:#0b0d12;color:#d7dce5;font:15px/1.5 system-ui,sans-serif';
    document.body.appendChild(root);
  }
  const text = document.createElement('p');
  text.style.cssText = 'max-width:32em;margin:0';
  text.textContent = message;
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload';
  reload.style.cssText = 'padding:8px 18px;cursor:pointer';
  reload.onclick = () => globalThis.location.reload();
  root.replaceChildren(text, reload);
}
