/**
 * audioControls.ts — a small mute + volume overlay bound to an AudioManager.
 *
 * A speaker button toggles mute; two always-visible sliders set the music and
 * SFX volumes. Purely presentational glue — all the audio behavior and
 * persistence lives in {@link AudioManager}. The `M` key shortcut is wired by
 * the caller so it composes with each driver's key handling.
 */

import type { AudioManager } from './audioManager.js';

export interface AudioControlsHandle {
  /** Refresh the button glyph after a programmatic mute toggle (e.g. the M key). */
  syncMuted(): void;
  remove(): void;
}

export function mountAudioControls(audio: AudioManager): AudioControlsHandle {
  const settings = audio.getSettings();

  const wrap = document.createElement('div');
  // z-index above the netplay lobby overlay (z-index 10) so the control is
  // reachable there too — the lobby plays the prelude, so it needs a mute.
  wrap.style.cssText =
    'position:fixed;top:12px;right:120px;z-index:20;display:flex;align-items:center;gap:8px;' +
    'font:12px system-ui,sans-serif;color:#d7dce5;';

  const btn = document.createElement('button');
  btn.type = 'button'; // avoid implicit form-submit semantics
  btn.style.cssText = 'padding:6px 10px;opacity:.85;cursor:pointer;min-width:34px';
  btn.title = 'Mute (M)';
  btn.setAttribute('aria-label', 'Mute audio');

  const panel = document.createElement('div');
  panel.style.cssText =
    'display:flex;align-items:center;gap:8px;background:rgba(11,13,18,.85);' +
    'padding:6px 10px;border-radius:6px';

  const slider = (label: string, value: number, on: (v: number) => void): HTMLElement => {
    const box = document.createElement('label');
    box.style.cssText = 'display:flex;align-items:center;gap:4px';
    box.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.value = String(Math.round(value * 100));
    input.style.width = '70px';
    input.oninput = (): void => on(Number(input.value) / 100);
    box.appendChild(input);
    return box;
  };

  panel.appendChild(slider('♪', settings.music, (v) => audio.setMusicVolume(v)));
  panel.appendChild(slider('▸', settings.sfx, (v) => audio.setSfxVolume(v)));

  const syncMuted = (): void => {
    const muted = audio.getSettings().muted;
    btn.textContent = muted ? '🔇' : '🔊';
    // Announce current state to assistive tech (toggle button semantics).
    btn.setAttribute('aria-pressed', String(muted));
    btn.setAttribute('aria-label', muted ? 'Unmute audio' : 'Mute audio');
  };
  syncMuted();

  btn.onclick = (): void => {
    audio.toggleMuted();
    syncMuted();
  };

  wrap.appendChild(panel);
  wrap.appendChild(btn);
  document.body.appendChild(wrap);

  return {
    syncMuted,
    remove(): void {
      wrap.remove();
    },
  };
}
