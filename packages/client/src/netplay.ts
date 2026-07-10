/**
 * netplay.ts — the head-to-head mode (Phase 4) + lobby (Phase 5).
 *
 * Wires the relay connection ({@link NetClient}), the lockstep driver
 * ({@link LockstepSession}), and two board renderers into a playable match.
 * The lobby screen shows a live room list with W-L records (create, click to
 * join, or join by code); identity persists in localStorage as a session
 * token, so records follow the player and a dropped connection can reclaim
 * its in-progress match: the client auto-reconnects with its token, receives
 * `match_resume`, rebuilds the session from the input ledgers, and fast-
 * forwards to the live frontier.
 *
 * Everything deterministic lives in the session; this file is DOM/WebGL glue.
 */

import { GameSim, GC_STEPS_PER_SECOND } from '@crack-attack/core';
import {
  DEFAULT_RECONNECT_GRACE_MS,
  PROTOCOL_VERSION,
  type MatchResumeMessage,
  type MatchStartMessage,
  type RoomSummary,
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
/** Extra ticks per frame while catching up after a resume (~10 s of sim/s). */
const CATCH_UP_STEPS_PER_FRAME = 500;
/** Reconnect attempt spacing while a match seat may still be held. */
const RECONNECT_INTERVAL_MS = 2000;

const STORAGE_TOKEN = 'crack-attack.token';
const STORAGE_NAME = 'crack-attack.name';

/** Everything one rendered board needs, bundled per player. */
interface BoardBundle {
  view: BoardView;
  interp: ViewInterpolator;
  signs: SignsView;
  decals: GarbageDecalView;
  levelLights: LevelLightsView;
}

type Phase = 'connecting' | 'lobby' | 'room' | 'playing' | 'ended';

export function bootNetplay(app: HTMLElement, hudEl: HTMLElement | null, relayUrl: string): void {
  // --- overlay UI ------------------------------------------------------------
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(11,13,18,.85);z-index:10;font-size:14px';
  const panel = document.createElement('div');
  panel.style.cssText =
    'display:flex;flex-direction:column;gap:10px;width:360px;max-height:80vh;padding:24px;' +
    'background:#161a22;border:1px solid #2a3140;border-radius:8px;overflow-y:auto';
  panel.innerHTML = `
    <strong style="font-size:16px">Crack Attack! lobby</strong>
    <div id="net-self" style="opacity:.8"></div>
    <label>Name <input id="net-name" maxlength="32" style="width:100%"></label>
    <div style="display:flex;gap:6px">
      <button id="net-create" style="flex:1">Create room</button>
      <input id="net-code" placeholder="code" maxlength="5"
             style="width:5.5em;text-transform:uppercase">
      <button id="net-join">Join</button>
    </div>
    <div id="net-rooms" style="display:flex;flex-direction:column;gap:4px"></div>
    <button id="net-ready" hidden>Ready</button>
    <div id="net-status" style="min-height:2.5em;opacity:.8"></div>`;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const $ = <T extends HTMLElement>(id: string): T => {
    const el = panel.querySelector<T>(`#${id}`);
    if (!el) throw new Error(`missing overlay element #${id}`);
    return el;
  };
  const selfEl = $<HTMLDivElement>('net-self');
  const nameInput = $<HTMLInputElement>('net-name');
  const createBtn = $<HTMLButtonElement>('net-create');
  const codeInput = $<HTMLInputElement>('net-code');
  const joinBtn = $<HTMLButtonElement>('net-join');
  const roomsEl = $<HTMLDivElement>('net-rooms');
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

  // --- persistent identity ------------------------------------------------------
  nameInput.value = localStorage.getItem(STORAGE_NAME) ?? 'player';
  nameInput.onchange = (): void => {
    localStorage.setItem(STORAGE_NAME, nameInput.value.trim() || 'player');
    setStatus('name change applies on the next connection');
  };

  // --- net + game state -----------------------------------------------------------
  let phase: Phase = 'connecting';
  let net: NetClient | null = null;
  let session: LockstepSession | null = null;
  let boards: [BoardBundle, BoardBundle] | null = null;
  let names: [string, string] = ['', ''];
  let localIndex = 0;
  let roomCode = '';
  let resultSent = false;
  let graceMs = DEFAULT_RECONNECT_GRACE_MS;
  let reconnectUntil = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const clock = new FixedTimestep();
  const input = new KeyboardInput();
  const hud = hudEl ? new HudView(hudEl) : null;

  function connect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const client: NetClient = new NetClient({
      onMessage: (msg) => handleMessage(msg),
      onClose: () => onConnectionLost(),
    });
    net = client;
    setStatus(`connecting to ${relayUrl}…`);
    client.connect(relayUrl).then(
      () => {
        const token = localStorage.getItem(STORAGE_TOKEN);
        client.send({
          type: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          name: nameInput.value.trim() || 'player',
          ...(token ? { token } : {}),
        });
      },
      (err: unknown) => {
        setStatus(err instanceof Error ? err.message : 'connection failed');
        onConnectionLost();
      },
    );
  }

  /** Reconnect with backoff while a match seat may still be held for us. */
  function onConnectionLost(): void {
    net = null;
    const midMatch = (phase === 'playing' || phase === 'ended') && session !== null;
    if (midMatch && reconnectUntil === 0) reconnectUntil = performance.now() + graceMs;

    if (midMatch && performance.now() < reconnectUntil) {
      showBanner('connection lost — reconnecting…');
      reconnectTimer = setTimeout(connect, RECONNECT_INTERVAL_MS);
      return;
    }
    // Lobby-phase drop (or grace exhausted): plain retry into the lobby.
    phase = 'connecting';
    session = null;
    overlay.style.display = 'flex';
    readyBtn.hidden = true;
    setStatus('disconnected — retrying…');
    reconnectTimer = setTimeout(connect, RECONNECT_INTERVAL_MS);
  }

  function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        localStorage.setItem(STORAGE_TOKEN, msg.token);
        selfEl.textContent = `${msg.name} — ${msg.record.wins}W / ${msg.record.losses}L`;
        if (phase === 'connecting') {
          phase = 'lobby';
          setStatus('connected');
        }
        break;
      case 'room_list':
        renderRoomList(msg.rooms);
        break;
      case 'room_created':
        phase = 'room';
        roomCode = msg.code;
        readyBtn.hidden = true;
        setStatus(`room ${msg.code} — share this code or wait for a lobby join…`);
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
        if (phase === 'playing' || phase === 'ended') endToRoom('');
        readyBtn.hidden = true;
        setStatus(`${msg.name} left. Waiting in room ${roomCode}…`);
        break;
      case 'peer_dropped':
        graceMs = msg.graceMs;
        showBanner(
          `${msg.name} disconnected — holding the match ${Math.round(msg.graceMs / 1000)}s for a reconnect…`,
        );
        break;
      case 'peer_rejoined':
        showBanner('');
        setStatus(`${msg.name} reconnected`);
        break;
      case 'match_start':
        startMatch(msg);
        break;
      case 'match_resume':
        resumeMatch(msg);
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

  function renderRoomList(rooms: RoomSummary[]): void {
    roomsEl.replaceChildren();
    if (rooms.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'opacity:.5;font-size:13px';
      empty.textContent = 'no open rooms — create one';
      roomsEl.appendChild(empty);
      return;
    }
    for (const room of rooms) {
      const row = document.createElement('button');
      row.style.cssText =
        'display:flex;justify-content:space-between;gap:8px;padding:6px 10px;text-align:left';
      const who = room.players
        .map((p) => `${p.name} (${p.record.wins}W/${p.record.losses}L)`)
        .join(' vs ');
      const label = document.createElement('span');
      label.textContent = `${room.code} · ${who || 'empty'}`;
      const state = document.createElement('span');
      state.style.opacity = '.6';
      const joinable = room.state === 'waiting' && room.players.length < 2;
      state.textContent = room.state === 'playing' ? 'playing' : joinable ? 'join' : 'full';
      row.append(label, state);
      row.disabled = !joinable || phase !== 'lobby';
      row.onclick = (): void => net?.send({ type: 'join_room', code: room.code });
      roomsEl.appendChild(row);
    }
  }

  const sendReady = (): void => {
    net?.send({ type: 'ready' });
    readyBtn.disabled = true;
    setStatus('ready — waiting for the opponent…');
  };
  readyBtn.onclick = sendReady;
  createBtn.onclick = (): void => net?.send({ type: 'create_room' });
  joinBtn.onclick = (): void =>
    net?.send({ type: 'join_room', code: codeInput.value.trim().toUpperCase() });

  function onMatchEnd(reason: string, winner: number | null): void {
    if (phase !== 'playing' && phase !== 'ended') return;
    phase = 'ended';
    // The relay has ended the match (concede/disconnect/desync may arrive
    // before the sims decide anything locally): freeze the session so the
    // loop stops stepping/sending and KeyR-rematch (gated on outcome) works.
    if (session && !session.outcome) {
      session.outcome = { winner, tick: session.currentTick };
      resultSent = true; // nothing to report; the relay already settled it
    }
    if (reason === 'concession' || reason === 'disconnect') {
      showBanner(
        winner === localIndex
          ? `You win — opponent ${reason === 'concession' ? 'conceded' : 'disconnected'}. R for rematch.`
          : 'You forfeited the match.',
      );
    }
    // 'result' confirms the outcome banner already on screen.
    readyBtn.hidden = false;
    readyBtn.disabled = false;
    readyBtn.textContent = 'Rematch';
  }

  /** Return from a dead match to the room/lobby overlay. */
  function endToRoom(bannerText: string): void {
    phase = 'room';
    session = null;
    overlay.style.display = 'flex';
    showBanner(bannerText);
  }

  // --- boards -------------------------------------------------------------------
  function makeBoards(localSim: GameSim, remoteSim: GameSim): [BoardBundle, BoardBundle] {
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
        view,
        interp,
        signs: new SignsView(view.scene, halfW, halfH),
        decals: new GarbageDecalView(view.scene, halfW, halfH),
        levelLights: new LevelLightsView(view.scene, halfW, halfH),
      };
    };
    // Local board left, opponent right, regardless of player index.
    return [make(localSim, 0), make(remoteSim, 1)];
  }

  function fitToWindow(): void {
    if (!boards) return;
    const w = globalThis.innerWidth / 2;
    const h = globalThis.innerHeight;
    boards[0].view.resize(w, h);
    boards[1].view.resize(w, h);
  }
  globalThis.addEventListener('resize', fitToWindow);

  function enterMatch(newSession: LockstepSession, players: [string, string]): void {
    session = newSession;
    localIndex = newSession.localIndex;
    names = players;
    phase = 'playing';
    resultSent = false;
    reconnectUntil = 0;
    overlay.style.display = 'none';
    readyBtn.textContent = 'Ready';
    showBanner('');
    input.clear();
    clock.reset();

    const localSim = newSession.sims[localIndex]!;
    const remoteSim = newSession.sims[1 - localIndex]!;
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

  function startMatch(msg: MatchStartMessage): void {
    enterMatch(new LockstepSession(msg.seed, msg.playerIndex, msg.inputDelay), msg.players);
  }

  function resumeMatch(msg: MatchResumeMessage): void {
    enterMatch(
      LockstepSession.resume(msg.seed, msg.playerIndex, msg.inputDelay, msg.frames),
      msg.players,
    );
    showBanner('reconnected — catching up…');
  }

  // --- input ---------------------------------------------------------------------
  globalThis.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.code === 'KeyR' && session?.outcome && (phase === 'playing' || phase === 'ended')) {
      sendReady();
      return;
    }
    if (e.code === 'Escape' && phase === 'playing' && !session?.outcome) {
      net?.send({ type: 'concede' });
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
        // Catch-up: after a resume the remote buffer runs deep; burn it down
        // in large chunks so reconnection takes moments, not match-time.
        const backlog = s.bufferedRemoteTicks;
        const budget = backlog > 25 ? Math.min(backlog, CATCH_UP_STEPS_PER_FRAME) : due;
        const catchingUp = backlog > 25;

        const stepped = s.advance(
          budget,
          () => input.actionState().state,
          () => {
            boards![0].interp.push(deriveViewModel(localSim));
            boards![1].interp.push(deriveViewModel(remoteSim));
          },
        );

        for (const batch of s.takeOutgoing()) {
          net?.send({ type: 'inputs', startTick: batch.startTick, frames: batch.frames });
        }
        for (const d of s.takeDigests()) {
          net?.send({ type: 'digest', tick: d.tick, digests: d.digests });
        }

        if (catchingUp) {
          showBanner('catching up…');
          waitingSince = null;
        } else if (stepped === 0 && due > 0 && s.waitingForRemote && net) {
          waitingSince ??= nowMs;
          if (nowMs - waitingSince > 250) showBanner(`waiting for ${names[1 - localIndex]}…`);
        } else if (
          waitingSince !== null ||
          banner.textContent === 'catching up…' ||
          banner.textContent === 'reconnected — catching up…'
        ) {
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
          if (!resultSent) {
            resultSent = true;
            net?.send({ type: 'result', winner });
          }
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

  // Kick everything off.
  connect();
}
