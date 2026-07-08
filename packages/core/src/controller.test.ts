import { describe, expect, it } from 'vitest';
import {
  ActionState,
  CC_ADVANCE,
  CC_DOWN,
  CC_LEFT,
  CC_RIGHT,
  CC_SWAP,
  CC_UP,
  noActions,
} from './controller.js';

describe('ActionState', () => {
  it('exposes only the movement bits from moveCommand', () => {
    const a = new ActionState(CC_LEFT | CC_SWAP);
    expect(a.moveCommand()).toBe(CC_LEFT);
    expect(a.swapCommand()).toBe(true);
    expect(a.advanceCommand()).toBe(false);
  });

  it('reports swap and advance independently', () => {
    const a = new ActionState(CC_ADVANCE);
    expect(a.moveCommand()).toBe(0);
    expect(a.swapCommand()).toBe(false);
    expect(a.advanceCommand()).toBe(true);
  });

  it('combines multiple movement bits', () => {
    const a = new ActionState(CC_UP | CC_RIGHT);
    expect(a.moveCommand()).toBe(CC_UP | CC_RIGHT);
  });

  it('noActions is fully neutral', () => {
    const a = noActions();
    expect(a.moveCommand()).toBe(0);
    expect(a.swapCommand()).toBe(false);
    expect(a.advanceCommand()).toBe(false);
    // sanity: DOWN is a distinct bit
    expect(CC_DOWN).not.toBe(CC_UP);
  });
});
