import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountTouchControls, prefersTouchControls } from './touchControls.js';

/**
 * A tiny DOM stub — just enough of Element/Document for {@link mountTouchControls}
 * to build its tree and for us to dispatch pointer events. Avoids pulling in a
 * full jsdom for one thin adapter.
 */
class FakeElement {
  className = '';
  textContent = '';
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  private readonly listeners = new Map<string, ((e: unknown) => void)[]>();
  private readonly classes = new Set<string>();
  readonly classList = {
    add: (c: string): void => void this.classes.add(c),
    remove: (c: string): void => void this.classes.delete(c),
    contains: (c: string): boolean => this.classes.has(c),
  };
  constructor(readonly tagName: string) {}
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  setPointerCapture(): void {}
  addEventListener(type: string, fn: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  appendChild(el: FakeElement): void {
    this.children.push(el);
  }
  append(...els: FakeElement[]): void {
    this.children.push(...els);
  }
  dispatch(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  /** Depth-first search for the first descendant whose class list contains `cls`. */
  find(cls: string): FakeElement | undefined {
    for (const child of this.children) {
      if (child.className.split(' ').includes(cls)) return child;
      const hit = child.find(cls);
      if (hit) return hit;
    }
    return undefined;
  }
}

const pointerEvent = (): unknown => ({ preventDefault: vi.fn(), pointerId: 1 });

describe('prefersTouchControls', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is true when the primary pointer is coarse', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(prefersTouchControls()).toBe(true);
  });

  it('is true when the device reports touch points', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('navigator', { maxTouchPoints: 5 });
    expect(prefersTouchControls()).toBe(true);
  });

  it('is false on a plain fine-pointer, no-touch device', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('navigator', { maxTouchPoints: 0 });
    expect(prefersTouchControls()).toBe(false);
  });
});

describe('mountTouchControls', () => {
  let body: FakeElement;

  beforeEach(() => {
    body = new FakeElement('body');
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    vi.stubGlobal('document', {
      createElement: (tag: string) => new FakeElement(tag),
      head: new FakeElement('head'),
      body,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does not mount when the device has no touch/coarse pointer', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('navigator', { maxTouchPoints: 0 });
    const sink = { press: vi.fn(), release: vi.fn(), restart: vi.fn() };
    expect(mountTouchControls(sink)).toBeNull();
    expect(sink.press).not.toHaveBeenCalled();
  });

  it('presses and releases the mapped code for each direction', () => {
    const sink = { press: vi.fn(), release: vi.fn(), restart: vi.fn() };
    const root = mountTouchControls(sink) as unknown as FakeElement;
    expect(root).not.toBeNull();

    for (const [cls, code] of [
      ['up', 'ArrowUp'],
      ['left', 'ArrowLeft'],
      ['right', 'ArrowRight'],
      ['down', 'ArrowDown'],
    ] as const) {
      const btn = root.find(cls)!;
      btn.dispatch('pointerdown', pointerEvent());
      expect(sink.press).toHaveBeenCalledWith(code);
      btn.dispatch('pointerup', pointerEvent());
      expect(sink.release).toHaveBeenCalledWith(code);
    }
  });

  it('maps swap to Space and raise to KeyX (held)', () => {
    const sink = { press: vi.fn(), release: vi.fn(), restart: vi.fn() };
    const root = mountTouchControls(sink) as unknown as FakeElement;

    root.find('swap')!.dispatch('pointerdown', pointerEvent());
    expect(sink.press).toHaveBeenCalledWith('Space');
    root.find('raise')!.dispatch('pointerdown', pointerEvent());
    expect(sink.press).toHaveBeenCalledWith('KeyX');
  });

  it('fires restart on the restart button and holds no command', () => {
    const sink = { press: vi.fn(), release: vi.fn(), restart: vi.fn() };
    const root = mountTouchControls(sink) as unknown as FakeElement;

    root.find('restart')!.dispatch('pointerdown', pointerEvent());
    expect(sink.restart).toHaveBeenCalledTimes(1);
    expect(sink.press).not.toHaveBeenCalled();
  });
});
