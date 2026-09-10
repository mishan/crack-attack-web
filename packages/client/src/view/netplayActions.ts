/**
 * netplayActions.ts — which netplay actions are on offer right now. The keys
 * (Esc concede, R rematch, Esc stop watching) have always worked; this drives
 * the matching on-screen buttons so mouse and touch players can do the same,
 * and decides when the touch pad shows. Pure, so the rules are unit-tested.
 */

export type NetplayPhase = 'connecting' | 'lobby' | 'room' | 'playing' | 'ended' | 'spectating';

export interface NetplayActionInput {
  readonly phase: NetplayPhase;
  /** The match has a result (decided by the sims, or ended by the relay). */
  readonly decided: boolean;
  /** Still inside the 3-2-1 countdown gate (concession is blocked, as in the C++). */
  readonly countdown: boolean;
  /** We've asked for a rematch and are waiting on the opponent. */
  readonly rematchSent: boolean;
}

export interface NetplayActions {
  readonly concede: 'hidden' | 'enabled' | 'disabled';
  readonly rematch: 'hidden' | 'enabled' | 'waiting';
  readonly leave: boolean;
  readonly stopWatching: boolean;
  /** The on-screen D-pad / Swap / Raise: live play only. */
  readonly touchPad: boolean;
}

export function netplayActions(s: NetplayActionInput): NetplayActions {
  const inMatch = s.phase === 'playing' || s.phase === 'ended';
  const live = inMatch && !s.decided;
  const over = inMatch && s.decided;
  return {
    concede: live ? (s.countdown ? 'disabled' : 'enabled') : 'hidden',
    rematch: over ? (s.rematchSent ? 'waiting' : 'enabled') : 'hidden',
    leave: over,
    stopWatching: s.phase === 'spectating',
    touchPad: live,
  };
}
