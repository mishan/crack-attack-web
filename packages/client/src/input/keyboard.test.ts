import { describe, expect, it } from 'vitest';
import { CC_ADVANCE, CC_LEFT, CC_MOVE_MASK, CC_RIGHT, CC_SWAP, CC_UP } from '@crack-attack/core';
import { DEFAULT_KEYMAP, KeyboardInput } from './keyboard.js';

describe('KeyboardInput', () => {
  it('maps a held direction to its command bit', () => {
    const kb = new KeyboardInput();
    kb.press('ArrowRight');
    expect(kb.command()).toBe(CC_RIGHT);
  });

  it('produces a valid ActionState the sim can read', () => {
    const kb = new KeyboardInput();
    kb.press('ArrowUp');
    kb.press('KeyZ');
    const a = kb.actionState();
    expect(a.moveCommand()).toBe(CC_UP);
    expect(a.swapCommand()).toBe(true);
    expect(a.advanceCommand()).toBe(false);
  });

  it('combines a movement with swap and advance', () => {
    const kb = new KeyboardInput();
    kb.press('ArrowLeft');
    kb.press('Space'); // swap
    kb.press('KeyX'); // advance
    const cmd = kb.command();
    expect(cmd & CC_MOVE_MASK).toBe(CC_LEFT);
    expect(cmd & CC_SWAP).toBe(CC_SWAP);
    expect(cmd & CC_ADVANCE).toBe(CC_ADVANCE);
  });

  it('normalizes two held directions to the most recent (single move bit)', () => {
    const kb = new KeyboardInput();
    kb.press('ArrowUp');
    kb.press('ArrowRight');
    // exactly one movement bit is set (never UP|RIGHT, which the Swapper ignores)
    const move = kb.command() & CC_MOVE_MASK;
    expect(move).toBe(CC_RIGHT);
    expect(Number.isInteger(Math.log2(move))).toBe(true); // a single bit
  });

  it('falls back to the still-held direction when the newest is released', () => {
    const kb = new KeyboardInput();
    kb.press('ArrowUp');
    kb.press('ArrowRight');
    kb.release('ArrowRight');
    expect(kb.command() & CC_MOVE_MASK).toBe(CC_UP);
  });

  it('treats WASD as aliases for the arrow keys', () => {
    const kb = new KeyboardInput();
    kb.press('KeyD');
    expect(kb.command()).toBe(CC_RIGHT);
  });

  it('ignores unmapped keys and auto-repeat re-presses', () => {
    const kb = new KeyboardInput();
    expect(kb.handles('KeyQ')).toBe(false);
    kb.press('KeyQ');
    kb.press('ArrowLeft');
    kb.press('ArrowLeft'); // auto-repeat: no duplicate
    kb.release('ArrowLeft');
    expect(kb.command()).toBe(0);
  });

  it('clear() drops all held keys', () => {
    const kb = new KeyboardInput();
    kb.press('ArrowLeft');
    kb.press('KeyZ');
    kb.clear();
    expect(kb.command()).toBe(0);
  });

  it('honors a custom keymap', () => {
    const kb = new KeyboardInput({ KeyJ: CC_LEFT } satisfies Record<string, number>);
    kb.press('KeyJ');
    kb.press('ArrowRight'); // not bound in the custom map
    expect(kb.command()).toBe(CC_LEFT);
    expect(DEFAULT_KEYMAP.ArrowRight).toBe(CC_RIGHT); // default map untouched
  });
});
