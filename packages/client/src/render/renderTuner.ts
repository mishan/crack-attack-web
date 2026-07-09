/**
 * renderTuner.ts — TEMPORARY on-screen knobs for dialing in the lighting/look.
 *
 * Mounts a small slider panel that drives {@link BoardView.applyRenderTuning}
 * live, so the block/garbage material and the key/fill lights can be tweaked by
 * eye. A "Copy values" button dumps the current {@link RenderTuning} as an object
 * literal (to the clipboard + console) so the winning numbers can be baked back
 * into `DEFAULT_RENDER_TUNING` and this whole file deleted.
 *
 * Not part of the shipped game — mount it behind a flag (e.g. `?tune`).
 */

import type { BoardView, RenderTuning } from './boardView.js';

/** The numeric (slider-able) fields of RenderTuning — excludes `flatShading`. */
type NumericKey = {
  [K in keyof RenderTuning]: RenderTuning[K] extends number ? K : never;
}[keyof RenderTuning];

interface Knob {
  key: NumericKey;
  label: string;
  min: number;
  max: number;
  step: number;
}

const KNOBS: Knob[] = [
  { key: 'keyAzimuthDeg', label: 'Key azimuth°', min: -90, max: 90, step: 1 },
  { key: 'keyElevationDeg', label: 'Key elevation°', min: 0, max: 90, step: 1 },
  { key: 'keyIntensity', label: 'Key intensity', min: 0, max: 3, step: 0.05 },
  { key: 'fillIntensity', label: 'Fill intensity', min: 0, max: 1.5, step: 0.05 },
  { key: 'ambient', label: 'Ambient', min: 0, max: 1.5, step: 0.05 },
  { key: 'shininess', label: 'Shininess', min: 1, max: 120, step: 1 },
  { key: 'specular', label: 'Specular (0–255)', min: 0, max: 255, step: 5 },
  { key: 'garbageRoughness', label: 'Garbage roughness', min: 0, max: 1, step: 0.05 },
];

const CSS = `
.render-tuner {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 20;
  width: 232px;
  padding: 10px 12px;
  background: rgba(16, 19, 26, 0.86);
  border: 1px solid rgba(215, 220, 229, 0.2);
  border-radius: 10px;
  color: #d7dce5;
  font: 12px/1.4 system-ui, sans-serif;
  backdrop-filter: blur(3px);
  user-select: none;
}
.render-tuner .tuner-header {
  display: block;
  width: 100%;
  margin: 0 0 8px;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  text-align: left;
  font: 600 12px/1.4 system-ui, sans-serif;
  letter-spacing: 0.02em;
  opacity: 0.8;
  cursor: pointer;
}
.render-tuner .tuner-header::after {
  content: ' ▾';
}
.render-tuner.collapsed .tuner-header::after {
  content: ' ▸';
}
.render-tuner .row { display: flex; flex-direction: column; margin: 6px 0; }
.render-tuner .row.toggle { flex-direction: row; align-items: center; gap: 8px; cursor: pointer; }
.render-tuner .row .top { display: flex; justify-content: space-between; }
.render-tuner .row .val { font-variant-numeric: tabular-nums; opacity: 0.85; }
.render-tuner input[type='range'] { width: 100%; accent-color: #6a86c8; }
.render-tuner button {
  width: 100%;
  margin-top: 8px;
  padding: 6px;
  border-radius: 8px;
  border: 1px solid rgba(215, 220, 229, 0.25);
  background: rgba(90, 110, 150, 0.5);
  color: #eef1f6;
  font: inherit;
  cursor: pointer;
}
.render-tuner.collapsed .body { display: none; }
`;

const format = (t: RenderTuning): string =>
  `{ ambient: ${t.ambient}, keyIntensity: ${t.keyIntensity}, ` +
  `keyAzimuthDeg: ${t.keyAzimuthDeg}, keyElevationDeg: ${t.keyElevationDeg}, ` +
  `fillIntensity: ${t.fillIntensity}, shininess: ${t.shininess}, ` +
  `specular: ${t.specular}, garbageRoughness: ${t.garbageRoughness}, ` +
  `flatShading: ${t.flatShading} }`;

/** Mount the tuner panel and wire it to `view`. Returns the root element. */
export function mountRenderTuner(view: BoardView, initial: RenderTuning): HTMLElement {
  const tuning: RenderTuning = { ...initial };
  // Apply the initial tuning immediately so the scene matches the overlay before
  // any slider is touched (and so non-default `initial` values take effect).
  view.applyRenderTuning(tuning);

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'render-tuner';

  // A real <button> so the collapse toggle is focusable and works with a keyboard
  // / assistive tech; aria-expanded reflects the state.
  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'tuner-header';
  header.textContent = 'Render tuner';
  header.setAttribute('aria-expanded', 'true');
  header.addEventListener('click', () => {
    const collapsed = root.classList.toggle('collapsed');
    header.setAttribute('aria-expanded', String(!collapsed));
  });
  root.appendChild(header);

  const body = document.createElement('div');
  body.className = 'body';
  root.appendChild(body);

  for (const knob of KNOBS) {
    const row = document.createElement('div');
    row.className = 'row';
    const top = document.createElement('div');
    top.className = 'top';
    const label = document.createElement('span');
    label.textContent = knob.label;
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = String(tuning[knob.key]);
    top.append(label, val);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(knob.min);
    slider.max = String(knob.max);
    slider.step = String(knob.step);
    slider.value = String(tuning[knob.key]);
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      tuning[knob.key] = v;
      val.textContent = String(v);
      view.applyRenderTuning(tuning);
    });

    row.append(top, slider);
    body.appendChild(row);
  }

  // Flat shading: a boolean toggle (crisp per-facet edges vs smooth normals).
  const toggleRow = document.createElement('label');
  toggleRow.className = 'row toggle';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = tuning.flatShading;
  const toggleLabel = document.createElement('span');
  toggleLabel.textContent = 'Flat shading (crisp facets)';
  checkbox.addEventListener('change', () => {
    tuning.flatShading = checkbox.checked;
    view.applyRenderTuning(tuning);
  });
  toggleRow.append(checkbox, toggleLabel);
  body.appendChild(toggleRow);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy values';
  copy.addEventListener('click', () => {
    const text = format(tuning);
    void globalThis.navigator?.clipboard?.writeText(text);
    console.log('RenderTuning', text);
    copy.textContent = 'Copied ✓';
    globalThis.setTimeout(() => (copy.textContent = 'Copy values'), 1200);
  });
  body.appendChild(copy);

  document.body.appendChild(root);
  return root;
}
