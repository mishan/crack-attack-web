/**
 * netplay.ts — the head-to-head mode (Phase 4 milestone).
 *
 * Wires the relay connection ({@link NetClient}), the lockstep driver
 * ({@link LockstepSession}), and two board renderers into a playable match:
 * a minimal room overlay (name → create/join by code → ready), then both
 * players' boards side by side — yours left, the opponent's right — stepping
 * in lockstep. R readies (and re-readies for a rematch), Escape concedes.
 *
 * Everything deterministic lives in the session; this file is DOM/WebGL glue.
 */

import { GameSim, GC_STEPS_PER_SECOND } from '@crack-attack/core';
import {
  PROTOCOL_VERSION,
  type MatchStartMessage,
  type ServerMessage,
} from '@crack-attack/protocol';
import { KeyboardInput } from './input/keyboard.js';
import { BoardView } from './render/boardView.js';
import { GarbageDecalView } from './render/garbageDecalView.js';
import { HudView } from './render/hudView.js';
import { LevelLightsView } from './render/levelLightsView.js';
import { SignsView } from './render/signsView.js';
import { FixedTimestep } from './sim/fixedTimestep.js';
import { deriveViewModel } from './view/boardViewModel.js';
import { ViewInterpolator } from './view/viewInterpolator.js';
import { LockstepSession } from './net/lockstep.js';
import { NetClient } from './net/session.js';

const MS_PER_TICK = 1000 / GC_STEPS_PER_SECOND;
const MAX_SIGN_DT_TICKS = 10;

/** Everything one rendered board needs, bundled per player. */
interface BoardBundle {
  container: HTMLDivElement;
  view: BoardView;
  interp: ViewInterpolator;
  signs: SignsView;
  decals: GarbageDecalView;
  levelLights: LevelLightsView;
}

type Phase = 'lobby' | 'room' | 'playing' | 'ended';

export function bootNetplay(app: HTMLElement, hudEl: HTMLElement | null, relayUrl: string): void {
  // --- overlay UI ------------------------------------------------------------
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(11,13,18,.85);z-index:10;font-size:14px';
  const panel = document.createElement('div');
  panel.style.cssText =
    'display:flex;flex-direction:column;gap:10px;min-width:280px;padding:24px;' +
    'background:#161a22;border:1px solid #2a3140;border-radius:8px';
  panel.innerHTML = `
    <strong style="font-size:16px">Head-to-head</strong>
    <label>Name <input id="net-name" maxlength="32" value="player" style="width:100%"></label>
    <button id="net-create">Create room</button>
    <div style="display:flex;gap:6px">
      <input id="net-code" placeholder="room code" maxlength="5"
             style="flex:1;text-transform:uppercase">
      <button id="net-join">Join</button>
    </div>
    <button id="net-ready" hidden>Ready</button>
    <div id="net-status" style="min-height:2.5em;opacity:.8"></div>`;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const $ = <T extends HTMLElement>(id: string): T => {
    const el = panel.querySelector<T>(`#${id}`);
    if (!el) throw new Error(`missing overlay element #${id}`);
    return el;
  };
  const nameInput = $<HTMLInputElement>('net-name');
  const createBtn = $<HTMLButtonElement>('net-create');
  const codeInput = $<HTMLInputElement>('net-code');
  const joinBtn = $<HTMLButtonElement>('net-join');
  const readyBtn = $<HTMLButtonElement>('net-ready');
  const statusEl = $<HTMLDivElement>('net-status');

  const banner = document.createElement('div');
  banner.style.cssText =
    'position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:5;' +
    'font-size:15px;background:rgba(22,26,34,.9);padding:8px 16px;border-radius:6px;' +
    'border:1px solid #2a3140;display:none';
  document.body.appendChild(banner);
  const showBanner = (text: string): void => {
    banner.textContent = text;
    banner.style.display = text ? 'block' : 'none';
  };

  const setStatus = (text: string): void => {
    statusEl.textContent = text;
  };

  // --- net + game state --------------------------------------------------------
  let phase: Phase = 'lobby';
  let connected = false;
  let pendingAction: (() => void) | null = null;
  let session: LockstepSession | null = null;
  let boards: [BoardBundle, BoardBundle] | null = null;
  let names: [string, string] = ['', ''];
  let localIndex = 0;
  let roomCode = '';

  const clock = new FixedTimestep();
  const input = new KeyboardInput();
  const hud = hudEl ? new HudView(hudEl) : null;

  const net = new NetClient({
    onMessage: (msg) => handleMessage(msg),
    onClose: (reason) => {
      connected = false;
      phase = 'lobby';
      overlay.style.display = 'flex';
      setStatus(`disconnected: ${reason}`);
    },
  });

  /** Connect + hello lazily on the first room action. */
  const withConnection = (action: () => void): void => {
    if (connected) {
      action();
      return;
    }
    pendingAction = action;
    setStatus(`connecting to ${relayUrl}…`);
    net.connect(relayUrl).then(
      () => {
        net.send({
          type: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          name: nameInput.value.trim() || 'player',
        });
      },
      (err: unknown) => setStatus(err instanceof Error ? err.message : 'connection failed'),
    );
  };

  createBtn.onclick = (): void => withConnection(() => net.send({ type: 'create_room' }));
  joinBtn.onclick = (): void =>
    withConnection(() =>
      net.send({ type: 'join_room', code: codeInput.value.trim().toUpperCase() }),
    );
  const sendReady = (): void => {
    net.send({ type: 'ready' });
    readyBtn.disabled = true;
    setStatus('ready — waiting for the opponent…');
  };
  readyBtn.onclick = sendReady;

  function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        connected = true;
        setStatus('connected');
        pendingAction?.();
        pendingAction = null;
        break;
      case 'room_created':
        phase = 'room';
        roomCode = msg.code;
        setStatus(`room ${msg.code} — share this code, waiting for an opponent…`);
        break;
      case 'room_joined':
        phase = 'room';
        roomCode = msg.code;
        readyBtn.hidden = false;
        readyBtn.disabled = false;
        setStatus(`room ${msg.code} — players: ${msg.players.join(', ')}. Press Ready.`);
        break;
      case 'peer_joined':
        readyBtn.hidden = false;
        readyBtn.disabled = false;
        setStatus(`${msg.name} joined room ${roomCode}. Press Ready.`);
        break;
      case 'peer_left':
        phase = 'room';
        session = null;
        overlay.style.display = 'flex';
        readyBtn.hidden = true;
        showBanner('');
        setStatus(`${msg.name} left. Waiting in room ${roomCode}…`);
        break;
      case 'match_start':
        startMatch(msg);
        break;
      case 'peer_inputs':
        if (session && msg.playerIndex !== localIndex) {
          session.addRemoteFrames(msg.startTick, msg.frames);
        }
        break;
      case 'desync':
        showBanner(`Desync detected at tick ${msg.tick} — match void.`);
        break;
      case 'match_end':
        onMatchEnd(msg.reason, msg.winner);
        break;
      case 'error':
        setStatus(`${msg.code}: ${msg.message}`);
        break;
    }
  }

  function onMatchEnd(reason: string, winner: number | null): void {
    if (phase !== 'playing' && phase !== 'ended') return;
    phase = 'ended';
    if (reason === 'concession' || reason === 'disconnect') {
      showBanner(
        winner === localIndex
          ? `You win — opponent ${reason === 'concession' ? 'conceded' : 'disconnected'}. R for rematch.`
          : 'You forfeited the match.',
      );
    }
    readyBtn.hidden = false;
    readyBtn.disabled = false;
    readyBtn.textContent = 'Rematch';
  }

  // --- boards -------------------------------------------------------------------
  function makeBoards(initialSim: GameSim, opponentSim: GameSim): [BoardBundle, BoardBundle] {
    const make = (sim: GameSim, side: 0 | 1): BoardBundle => {
      const container = document.createElement('div');
      container.style.cssText = `position:absolute;top:0;bottom:0;width:50%;${side === 0 ? 'left:0' : 'right:0'}`;
      app.appendChild(container);
      const vm = deriveViewModel(sim);
      const interp = new ViewInterpolator();
      interp.push(vm);
      const view = new BoardView(container, vm.width, vm.visibleHeight);
      const halfW = (vm.width - 1) / 2;
      const halfH = (vm.visibleHeight - 1) / 2;
      return {
        container,
        view,
        interp,
        signs: new SignsView(view.scene, halfW, halfH),
        decals: new GarbageDecalView(view.scene, halfW, halfH),
        levelLights: new LevelLightsView(view.scene, halfW, halfH),
      };
    };
    // Local board left, opponent right, regardless of player index.
    return [make(initialSim, 0), make(opponentSim, 1)];
  }

  function fitToWindow(): void {
    if (!boards) return;
    const w = globalThis.innerWidth / 2;
    const h = globalThis.innerHeight;
    boards[0].view.resize(w, h);
    boards[1].view.resize(w, h);
  }
  globalThis.addEventListener('resize', fitToWindow);

  function startMatch(msg: MatchStartMessage): void {
    localIndex = msg.playerIndex;
    names = msg.players;
    session = new LockstepSession(msg.seed, localIndex, msg.inputDelay);
    phase = 'playing';
    overlay.style.display = 'none';
    readyBtn.textContent = 'Ready';
    showBanner('');
    input.clear();
    clock.reset();

    const localSim = session.sims[localIndex]!;
    const remoteSim = session.sims[1 - localIndex]!;
    if (!boards) {
      boards = makeBoards(localSim, remoteSim);
      fitToWindow();
    } else {
      for (const b of boards) {
        b.interp.reset();
        b.signs.clear();
        b.decals.clear();
      }
      boards[0].interp.push(deriveViewModel(localSim));
      boards[1].interp.push(deriveViewModel(remoteSim));
    }
  }

  // --- input ---------------------------------------------------------------------
  globalThis.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.code === 'KeyR' && session?.outcome && phase !== 'lobby') {
      sendReady();
      return;
    }
    if (e.code === 'Escape' && phase === 'playing') {
      net.send({ type: 'concede' });
      return;
    }
    if (phase === 'playing' && input.handles(e.code)) {
      input.press(e.code);
      e.preventDefault();
    }
  });
  globalThis.addEventListener('keyup', (e: KeyboardEvent) => input.release(e.code));
  globalThis.addEventListener('blur', () => input.clear());

  // --- loop ------------------------------------------------------------------------
  let lastMs = performance.now();
  let waitingSince: number | null = null;

  const frame = (nowMs: number): void => {
    const s = session;
    if (s && boards && (phase === 'playing' || phase === 'ended')) {
      const localSim = s.sims[localIndex]!;
      const remoteSim = s.sims[1 - localIndex]!;

      if (!s.outcome) {
        const due = clock.sample(nowMs);
        const stepped = s.advance(
          due,
          () => input.actionState().state,
          () => {
            boards![0].interp.push(deriveViewModel(localSim));
            boards![1].interp.push(deriveViewModel(remoteSim));
          },
        );

        // Ship this frame's input batches and any due digest snapshots.
        for (const batch of s.takeOutgoing()) {
          net.send({ type: 'inputs', startTick: batch.startTick, frames: batch.frames });
        }
        for (const d of s.takeDigests()) {
          net.send({ type: 'digest', tick: d.tick, digests: d.digests });
        }

        // Waiting indicator when lockstep is starved of opponent input.
        if (stepped === 0 && due > 0 && s.waitingForRemote) {
          waitingSince ??= nowMs;
          if (nowMs - waitingSince > 250) showBanner(`waiting for ${names[1 - localIndex]}…`);
        } else if (waitingSince !== null) {
          waitingSince = null;
          showBanner('');
        }

        if (s.outcome) {
          const { winner } = s.outcome;
          showBanner(
            winner === null
              ? 'Draw — you topped out together. R for rematch.'
              : winner === localIndex
                ? 'You win! R for rematch.'
                : 'You lose. R for rematch.',
          );
          readyBtn.hidden = false;
          readyBtn.disabled = false;
          readyBtn.textContent = 'Rematch';
        }

        for (const ev of localSim.drainSignEvents()) {
          boards[0].signs.spawn(ev.gridX, ev.gridY, ev.kind, ev.level);
        }
        for (const ev of remoteSim.drainSignEvents()) {
          boards[1].signs.spawn(ev.gridX, ev.gridY, ev.kind, ev.level);
        }
      }

      const dtTicks = Math.min(MAX_SIGN_DT_TICKS, (nowMs - lastMs) / MS_PER_TICK);
      const alpha = s.outcome ? 1 : clock.alpha;
      boards.forEach((b, i) => {
        b.signs.update(dtTicks);
        const vm = b.interp.sample(alpha);
        b.view.update(vm);
        b.decals.update(vm.garbage);
        b.levelLights.update(vm.hud.topEffectiveRow);
        b.view.render();
        if (i === 0) hud?.update(vm.hud);
      });
    }
    lastMs = nowMs;
    globalThis.requestAnimationFrame(frame);
  };
  globalThis.requestAnimationFrame(frame);
}
