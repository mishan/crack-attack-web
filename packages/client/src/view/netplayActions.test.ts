import { describe, expect, it } from 'vitest';
import { netplayActions, type NetplayActionInput } from './netplayActions.js';

const base: NetplayActionInput = {
  phase: 'playing',
  decided: false,
  countdown: false,
  rematchSent: false,
};

describe('netplayActions', () => {
  it('offers Concede and the touch pad during live play', () => {
    expect(netplayActions(base)).toEqual({
      concede: 'enabled',
      rematch: 'hidden',
      leave: false,
      stopWatching: false,
      touchPad: true,
    });
  });

  it('disables Concede during the countdown, as the C++ does', () => {
    expect(netplayActions({ ...base, countdown: true }).concede).toBe('disabled');
  });

  it('offers Rematch and Leave once the match is decided, and hides the pad', () => {
    for (const phase of ['playing', 'ended'] as const) {
      const a = netplayActions({ ...base, phase, decided: true });
      expect(a).toMatchObject({ concede: 'hidden', rematch: 'enabled', leave: true });
      expect(a.touchPad).toBe(false);
    }
  });

  it('shows Rematch as waiting after it has been sent', () => {
    expect(netplayActions({ ...base, decided: true, rematchSent: true }).rematch).toBe('waiting');
  });

  it('offers only Stop watching to a spectator', () => {
    expect(netplayActions({ ...base, phase: 'spectating' })).toEqual({
      concede: 'hidden',
      rematch: 'hidden',
      leave: false,
      stopWatching: true,
      touchPad: false,
    });
  });

  it('offers nothing outside a match (the lobby panel has its own buttons)', () => {
    for (const phase of ['connecting', 'lobby', 'room'] as const) {
      expect(netplayActions({ ...base, phase })).toEqual({
        concede: 'hidden',
        rematch: 'hidden',
        leave: false,
        stopWatching: false,
        touchPad: false,
      });
    }
  });
});
