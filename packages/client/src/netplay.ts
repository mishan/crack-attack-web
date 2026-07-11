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
  type SpectateStartMessage,
} from '@crack-attack/protocol';
import { KeyboardInput } from './input/keyboard.js';
import { BoardView } from './render/boardView.js';
import { GarbageDecalView } from './render/garbageDecalView.js';
import { HudView } from './render/hudView.js';
import { LevelLightsView } from './render/levelLightsView.js';
import { LoseBarView } from './render/loseBarView.js';
import { SignsView } from './render/signsView.js';
import { MessageOverlay } from './render/messageOverlay.js';
import { SparklesView } from './render/sparklesView.js';
import { BitmapLabel } from './render/bitmapText.js';
import { FONT0 } from './view/bitmapFont.js';
import { FixedTimestep } from './sim/fixedTimestep.js';
import { deriveViewModel } from './view/boardViewModel.js';
import {
  COUNTDOWN_GATE_TICKS,
  GO_DISPLAY_TICKS,
  countdownMessage,
  type MessageKind,
} from './view/messages.js';
import { Spring } from './view/spring.js';
import { Celebration } from './view/celebration.js';
import { ViewInterpolator } from './view/viewInterpolator.js';
import { LockstepSession } from './net/lockstep.js';
import { NetClient } from './net/session.js';
import { SpectatorSession } from './net/spectator.js';
import type { AudioManager } from './audio/audioManager.js';

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
  container: HTMLDivElement;
  view: BoardView;
  interp: ViewInterpolator;
  signs: SignsView;
  decals: GarbageDecalView;
  levelLights: LevelLightsView;
  loseBar: LoseBarView;
  spring: Spring;
  sparkles: SparklesView;
  /** Player name shown above the board, in the original bitmap font. */
  nameLabel: BitmapLabel;
}

type Phase = 'connecting' | 'lobby' | 'room' | 'playing' | 'ended' | 'spectating';

/** A running netplay mode; `dispose` tears everything down (mode switch). */
export interface NetplayHandle {
  dispose(): void;
}

export function bootNetplay(
  app: HTMLElement,
  hudEl: HTMLElement | null,
  relayUrl: string,
  onExit: () => void,
  audio: AudioManager,
): NetplayHandle {
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
    <div id="net-status" style="min-height:2.5em;opacity:.8"></div>
    <button id="net-solo" style="opacity:.8">Back to solo play</button>`;
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
  let record = { wins: 0, losses: 0 };
  const showSelf = (name: string): void => {
    selfEl.textContent = `${name} — ${record.wins}W / ${record.losses}L`;
  };
  nameInput.onchange = (): void => {
    const name = nameInput.value.trim() || 'player';
    nameInput.value = name;
    localStorage.setItem(STORAGE_NAME, name);
    // Live rename: takes effect immediately, no reconnect needed. (Names shown
    // inside a running match refresh at the next game.)
    net?.send({ type: 'rename', name });
    showSelf(name);
    setStatus(net ? 'name updated' : 'name saved — applies when connected');
  };

  // Small fixed chrome for the watcher roster + spectated-match title.
  const rosterEl = document.createElement('div');
  rosterEl.style.cssText =
    'position:fixed;bottom:12px;right:12px;z-index:5;font-size:12px;opacity:.7;display:none';
  document.body.appendChild(rosterEl);
  const titleEl = document.createElement('div');
  titleEl.style.cssText =
    'position:fixed;top:12px;right:12px;z-index:5;font-size:13px;opacity:.85;display:none';
  document.body.appendChild(titleEl);
  const showRoster = (names: string[]): void => {
    rosterEl.textContent = names.length ? `watching: ${names.join(', ')}` : '';
    rosterEl.style.display = names.length ? 'block' : 'none';
  };

  // --- net + game state -----------------------------------------------------------
  let phase: Phase = 'connecting';
  let net: NetClient | null = null;
  let session: LockstepSession | null = null;
  let spectator: SpectatorSession | null = null;
  let boards: [BoardBundle, BoardBundle] | null = null;
  let names: [string, string] = ['', ''];
  let localIndex = 0;
  let roomCode = '';
  let resultSent = false;
  let graceMs = DEFAULT_RECONNECT_GRACE_MS;
  let reconnectUntil = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let rafId = 0;
  /** Ticks since game start, counting the held countdown gate. */
  let metaTicks = 0;
  /** Big result image once the game is decided (winner/loser/draw). */
  let resultKind: MessageKind | null = null;
  // Audio lifecycle for the current match (game music at GO, stinger at the end).
  let gameMusicOn = false;
  let endMusicOn = false;

  /**
   * Set up music for a match about to begin. Fresh games fade the lobby prelude
   * over the 3-2-1 countdown and start the game loop at GO; a resume/mid-match
   * join skips the countdown and drops straight into the game loop.
   */
  function beginMatchAudio(skipCountdown: boolean): void {
    gameMusicOn = false;
    endMusicOn = false;
    if (skipCountdown) {
      audio.skipCountdown();
      gameMusicOn = true;
      audio.playGame();
    } else {
      audio.resetCountdown();
      audio.fadeoutMusic(3000);
    }
  }

  const clock = new FixedTimestep();
  const input = new KeyboardInput();
  const bigMessage = new MessageOverlay(app);
  const hud = hudEl ? new HudView(hudEl) : null;
  // End-of-match celebration (WINNER scales in + flashes; LOSER / GAME OVER
  // drops and bounces; the board dims). Runs on wall-clock ticks after the
  // match is decided; `celebAccum` carries the fractional-tick remainder.
  const celebration = new Celebration();
  let celebAccum = 0;

  // The lobby plays the menu prelude (switching from any solo game music).
  audio.playPrelude();

  /** Clear the big-message state (leaving a match, back to lobby/room). */
  function clearOverlay(): void {
    resultKind = null;
    bigMessage.show(null);
    celebration.stop();
    celebAccum = 0;
    bigMessage.setCelebration(null);
  }

  function connect(): void {
    if (disposed) return;
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
    if (disposed) return; // mode switched away; stay quiet
    // connect() can fail twice for one attempt (promise rejection AND the
    // socket's close event); never stack reconnect timers.
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const midMatch = (phase === 'playing' || phase === 'ended') && session !== null;
    if (midMatch && reconnectUntil === 0) reconnectUntil = performance.now() + graceMs;

    if (midMatch && performance.now() < reconnectUntil) {
      showBanner('connection lost — reconnecting…');
      reconnectTimer = setTimeout(connect, RECONNECT_INTERVAL_MS);
      return;
    }
    // Lobby-phase drop (or grace exhausted): plain retry into the lobby.
    // Spectators reattach by simply re-watching — no grace to burn.
    phase = 'connecting';
    session = null;
    spectator = null;
    overlay.style.display = 'flex';
    readyBtn.hidden = true;
    titleEl.style.display = 'none';
    showRoster([]);
    clearOverlay();
    setStatus('disconnected — retrying…');
    reconnectTimer = setTimeout(connect, RECONNECT_INTERVAL_MS);
  }

  function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        localStorage.setItem(STORAGE_TOKEN, msg.token);
        record = msg.record;
        showSelf(msg.name);
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
      case 'spectate_joined':
        phase = 'spectating';
        roomCode = msg.code;
        readyBtn.hidden = true;
        showRoster(msg.spectators);
        setStatus(
          msg.players.length === 2
            ? `watching room ${msg.code} — ${msg.players.join(' vs ')}`
            : `watching room ${msg.code} — waiting for players…`,
        );
        break;
      case 'spectate_start':
        startSpectating(msg);
        break;
      case 'spectators':
        showRoster(msg.names);
        break;
      case 'room_closed':
        spectator = null;
        phase = 'lobby';
        overlay.style.display = 'flex';
        titleEl.style.display = 'none';
        showRoster([]);
        showBanner('');
        clearOverlay();
        setStatus('the room you were watching closed');
        break;
      case 'peer_inputs':
        if (spectator) {
          spectator.addFrames(msg.playerIndex, msg.startTick, msg.frames);
        } else if (session && msg.playerIndex !== localIndex) {
          session.addRemoteFrames(msg.startTick, msg.frames);
        }
        break;
      case 'desync':
        showBanner(`Desync detected at tick ${msg.tick} — match void.`);
        break;
      case 'match_end':
        if (phase === 'spectating') {
          if (spectator && !spectator.outcome) {
            spectator.outcome = { winner: msg.winner, tick: spectator.currentTick };
          }
          showBanner(
            msg.winner === null ? 'Match void.' : `${names[msg.winner]} wins (${msg.reason}).`,
          );
          break;
        }
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
      const watchers = room.spectators.length ? ` · 👁${room.spectators.length}` : '';
      label.textContent = `${room.code} · ${who || 'empty'}${watchers}`;
      const state = document.createElement('span');
      state.style.opacity = '.6';
      const joinable = room.state === 'waiting' && room.players.length < 2;
      state.textContent = room.state === 'playing' ? 'playing' : joinable ? 'join' : 'full';
      row.append(label, state);
      row.disabled = !joinable || phase !== 'lobby';
      row.onclick = (): void => net?.send({ type: 'join_room', code: room.code });

      const watchBtn = document.createElement('button');
      watchBtn.textContent = 'watch';
      watchBtn.style.cssText = 'padding:6px 10px';
      watchBtn.disabled = phase !== 'lobby';
      watchBtn.onclick = (): void => net?.send({ type: 'spectate', code: room.code });

      const line = document.createElement('div');
      line.style.cssText = 'display:flex;gap:4px';
      row.style.flex = '1';
      line.append(row, watchBtn);
      roomsEl.appendChild(line);
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
    resultKind ??=
      winner === null
        ? 'message_game_over'
        : winner === localIndex
          ? 'message_winner'
          : 'message_loser';
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
    clearOverlay();
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
      const levelLights = new LevelLightsView(view.scene, halfW, halfH);
      levelLights.reset(vm.hud.topEffectiveRow);
      // Player name above the board, in the original bitmap font.
      const nameLabel = new BitmapLabel(FONT0, { height: 24, color: '#e7ebf3' });
      const nameBar = document.createElement('div');
      nameBar.style.cssText =
        'position:absolute;top:10px;left:0;right:0;display:flex;justify-content:center;' +
        'pointer-events:none;z-index:2';
      nameBar.append(nameLabel.element);
      container.append(nameBar);
      return {
        container,
        view,
        interp,
        signs: new SignsView(view.scene, halfW, halfH),
        decals: new GarbageDecalView(view.scene, halfW, halfH),
        levelLights,
        loseBar: new LoseBarView(view.scene, halfW, halfH),
        spring: new Spring(),
        sparkles: new SparklesView(view.scene, halfW, halfH),
        nameLabel,
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

  function enterMatch(
    newSession: LockstepSession,
    players: [string, string],
    resume: boolean,
  ): void {
    session = newSession;
    spectator = null;
    titleEl.style.display = 'none';
    localIndex = newSession.localIndex;
    names = players;
    phase = 'playing';
    resultSent = false;
    reconnectUntil = 0;
    // Fresh games run the 3-2-1-GO gate; a resume rejoins live play.
    metaTicks = resume ? COUNTDOWN_GATE_TICKS + GO_DISPLAY_TICKS : 0;
    clearOverlay();
    overlay.style.display = 'none';
    readyBtn.textContent = 'Ready';
    showBanner('');
    input.clear();
    clock.reset();
    beginMatchAudio(resume);

    const localSim = newSession.sims[localIndex]!;
    const remoteSim = newSession.sims[1 - localIndex]!;
    if (!boards) {
      boards = makeBoards(localSim, remoteSim);
      fitToWindow();
    }
    resetBoards(localSim, remoteSim, resume);
    // Local board is on the left, opponent on the right.
    applyBoardNames(names[localIndex] ?? '', names[1 - localIndex] ?? '');
  }

  /** Set the two per-board name labels (left, right). */
  function applyBoardNames(left: string, right: string): void {
    if (!boards) return;
    boards[0].nameLabel.setText(left);
    boards[1].nameLabel.setText(right);
  }

  /**
   * Reset board bundles for a fresh game (rematch/resume/spectate). `instant`
   * skips the level lights' start-of-game fade (no countdown will cover it).
   */
  function resetBoards(leftSim: GameSim, rightSim: GameSim, instant: boolean): void {
    if (!boards) return;
    const sims = [leftSim, rightSim];
    boards.forEach((b, i) => {
      b.interp.reset();
      b.signs.clear();
      b.decals.clear();
      b.sparkles.clear();
      b.spring.gameStart();
      b.view.setShake(0);
      const vm = deriveViewModel(sims[i]!);
      b.interp.push(vm);
      b.levelLights.reset(vm.hud.topEffectiveRow, instant);
      b.loseBar.reset();
    });
  }

  function startMatch(msg: MatchStartMessage): void {
    enterMatch(new LockstepSession(msg.seed, msg.playerIndex, msg.inputDelay), msg.players, false);
  }

  /** Enter (or re-enter, on a rematch) the watcher view for a live game. */
  function startSpectating(msg: SpectateStartMessage): void {
    spectator = new SpectatorSession(msg.seed, msg.frames);
    session = null;
    names = msg.players;
    phase = 'spectating';
    // From-the-start watches see the players' countdown; mid-match joins skip it.
    const midMatch = msg.frames[0].length > 0 || msg.frames[1].length > 0;
    metaTicks = midMatch ? COUNTDOWN_GATE_TICKS + GO_DISPLAY_TICKS : 0;
    clearOverlay();
    overlay.style.display = 'none';
    showBanner(midMatch ? 'catching up…' : '');
    titleEl.textContent = `${msg.players[0]} vs ${msg.players[1]}`;
    titleEl.style.display = 'block';
    clock.reset();
    beginMatchAudio(midMatch);

    if (!boards) {
      boards = makeBoards(spectator.sims[0]!, spectator.sims[1]!);
      fitToWindow();
    }
    resetBoards(spectator.sims[0]!, spectator.sims[1]!, midMatch);
    // Watcher view is "A vs B" in player order (no local/remote swap).
    applyBoardNames(names[0], names[1]);
  }

  function resumeMatch(msg: MatchResumeMessage): void {
    enterMatch(
      LockstepSession.resume(msg.seed, msg.playerIndex, msg.inputDelay, msg.frames),
      msg.players,
      true,
    );
    showBanner('reconnected — catching up…');
  }

  // --- input ---------------------------------------------------------------------
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'KeyR' && session?.outcome && (phase === 'playing' || phase === 'ended')) {
      sendReady();
      return;
    }
    if (e.code === 'Escape' && phase === 'spectating') {
      net?.send({ type: 'leave_room' });
      spectator = null;
      phase = 'lobby';
      overlay.style.display = 'flex';
      titleEl.style.display = 'none';
      showRoster([]);
      showBanner('');
      clearOverlay();
      setStatus('stopped watching');
      audio.playPrelude(); // back to lobby menu music
      return;
    }
    if (e.code === 'Escape' && phase === 'playing' && !session?.outcome) {
      // Concession is blocked during the countdown, as in the C++
      // (Game::concession returns early while the gate runs, Game.cxx:186).
      if (metaTicks < COUNTDOWN_GATE_TICKS) return;
      net?.send({ type: 'concede' });
      return;
    }
    if (phase === 'playing' && input.handles(e.code)) {
      input.press(e.code);
      e.preventDefault();
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => input.release(e.code);
  const onBlur = (): void => input.clear();
  globalThis.addEventListener('keydown', onKeyDown);
  globalThis.addEventListener('keyup', onKeyUp);
  globalThis.addEventListener('blur', onBlur);

  // --- loop ------------------------------------------------------------------------
  let lastMs = performance.now();
  let waitingSince: number | null = null;

  const frame = (nowMs: number): void => {
    if (disposed) return;
    // --- watcher branch: no input, no sending; just consume and render.
    if (spectator && boards && phase === 'spectating') {
      const w = spectator;
      let steppedTicks = 0;
      let lightsTicks = 0;
      if (!w.outcome) {
        const due = clock.sample(nowMs);
        // Display-only countdown mirror: the players are gated for the same
        // wall time, so no frames arrive while 3-2-1 shows here. The lights
        // fade across the gate here too.
        lightsTicks += Math.max(0, Math.min(due, COUNTDOWN_GATE_TICKS - metaTicks));
        if (metaTicks < COUNTDOWN_GATE_TICKS + GO_DISPLAY_TICKS) metaTicks += due;
        const backlog = w.bufferedTicks;
        const budget = backlog > 25 ? Math.min(backlog, CATCH_UP_STEPS_PER_FRAME) : due;
        steppedTicks = w.advance(budget, () => {
          boards![0].interp.push(deriveViewModel(w.sims[0]!));
          boards![1].interp.push(deriveViewModel(w.sims[1]!));
        });
        lightsTicks += steppedTicks;

        // Audio: mirror the players' countdown beeps; game music at GO.
        audio.updateCountdown(metaTicks);
        if (!gameMusicOn && metaTicks >= COUNTDOWN_GATE_TICKS) {
          gameMusicOn = true;
          audio.playGame();
        }

        if (w.outcome) {
          const { winner } = w.outcome;
          resultKind = 'message_game_over';
          showBanner(winner === null ? 'Draw — both topped out.' : `${names[winner]} wins!`);
          if (!endMusicOn) {
            endMusicOn = true;
            if (winner === null) audio.playGameOver();
            else audio.playYouWin();
          }
        } else if (backlog <= 25 && banner.textContent === 'catching up…') {
          showBanner('');
        }
        const catchingUp = backlog > 25;
        for (let i = 0; i < 2; i++) {
          for (const ev of w.sims[i]!.drainSignEvents()) {
            boards[i]!.signs.spawn(ev.gridX, ev.gridY, ev.kind, ev.level);
          }
          // A watcher hears both boards; suppress the burst while catching up.
          if (catchingUp) w.sims[i]!.drainSoundEvents();
          else audio.playCues(w.sims[i]!.drainSoundEvents());
        }
      }
      bigMessage.show(resultKind ?? countdownMessage(metaTicks));

      const impacts = [w.sims[0]!.drainImpactEvents(), w.sims[1]!.drainImpactEvents()];
      const dtTicks = Math.min(MAX_SIGN_DT_TICKS, (nowMs - lastMs) / MS_PER_TICK);
      bigMessage.update(dtTicks);
      const alpha = w.outcome ? 1 : clock.alpha;
      boards.forEach((b, i) => {
        b.signs.update(dtTicks);
        for (const imp of impacts[i]!) b.spring.notifyImpact(imp.height, imp.width);
        for (let t = 0; t < steppedTicks; t++) b.spring.timeStep();
        b.view.setShake(b.spring.offsetCells);
        const sim = w.sims[i]!;
        for (const ev of sim.drainSparkEvents())
          b.sparkles.spawnSparks(ev.x, ev.y, ev.flavor, ev.count);
        for (const ev of sim.drainMoteEvents())
          b.sparkles.spawnMote(ev.x, ev.y, ev.level, ev.sibling);
        b.sparkles.advance(steppedTicks);
        b.sparkles.sync();
        const vm = b.interp.sample(alpha);
        b.view.update(vm);
        b.decals.update(vm.garbage);
        b.levelLights.update(lightsTicks, vm.hud.topEffectiveRow, !w.outcome, impacts[i]!);
        b.loseBar.update(steppedTicks, sim.creep.creep_freeze, sim.creep.loss_alarm);
        b.view.render();
      });
      lastMs = nowMs;
      rafId = globalThis.requestAnimationFrame(frame);
      return;
    }

    const s = session;
    if (s && boards && (phase === 'playing' || phase === 'ended')) {
      const localSim = s.sims[localIndex]!;
      const remoteSim = s.sims[1 - localIndex]!;
      let steppedTicks = 0;
      let lightsTicks = 0; // lights also tick through the gate (Game.cxx:389)
      let wantWaiting = false;

      if (!s.outcome) {
        let due = clock.sample(nowMs);
        // Countdown gate (Game.cxx:399-408): the sim is held — and nothing is
        // sent — for the first COUNTDOWN_GATE_TICKS while 3-2-1 shows. Both
        // clients gate identically; lockstep buffering absorbs the skew.
        if (metaTicks < COUNTDOWN_GATE_TICKS) {
          const burn = Math.min(due, COUNTDOWN_GATE_TICKS - metaTicks);
          metaTicks += burn;
          due -= burn;
          lightsTicks += burn;
        }
        const gateActive = metaTicks < COUNTDOWN_GATE_TICKS;
        // Catch-up: after a resume the remote buffer runs deep; burn it down
        // in large chunks so reconnection takes moments, not match-time.
        const backlog = s.bufferedRemoteTicks;
        const budget = gateActive
          ? 0
          : backlog > 25
            ? Math.min(backlog, CATCH_UP_STEPS_PER_FRAME)
            : due;
        const catchingUp = !gateActive && backlog > 25;

        const stepped = s.advance(
          budget,
          () => input.actionState().state,
          () => {
            boards![0].interp.push(deriveViewModel(localSim));
            boards![1].interp.push(deriveViewModel(remoteSim));
          },
        );
        steppedTicks = stepped;
        lightsTicks += stepped;
        metaTicks += stepped; // times the GO tail of the countdown

        // Audio: countdown beeps track the meta timeline; game music at GO.
        audio.updateCountdown(metaTicks);
        if (!gameMusicOn && metaTicks >= COUNTDOWN_GATE_TICKS) {
          gameMusicOn = true;
          audio.playGame();
        }

        if (!gateActive) {
          for (const batch of s.takeOutgoing()) {
            net?.send({ type: 'inputs', startTick: batch.startTick, frames: batch.frames });
          }
          for (const d of s.takeDigests()) {
            net?.send({ type: 'digest', tick: d.tick, digests: d.digests });
          }
        }

        if (catchingUp) {
          showBanner('catching up…');
          waitingSince = null;
        } else if (!gateActive && stepped === 0 && due > 0 && s.waitingForRemote && net) {
          waitingSince ??= nowMs;
          // The reference's MS_WAITING message, in place of a text banner.
          if (nowMs - waitingSince > 250) wantWaiting = true;
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
          resultKind =
            winner === null
              ? 'message_game_over'
              : winner === localIndex
                ? 'message_winner'
                : 'message_loser';
          showBanner(winner === null ? 'Draw — R for rematch.' : 'R for rematch.');
          if (!resultSent) {
            resultSent = true;
            net?.send({ type: 'result', winner });
          }
          if (!endMusicOn) {
            endMusicOn = true;
            // Win → youwin, loss/draw → gameover (C++ CelebrationManager).
            if (winner === localIndex) audio.playYouWin();
            else audio.playGameOver();
          }
          if (!celebration.active) celebration.start(winner === localIndex ? 'win' : 'loss');
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

        // Sound cues: play the local board (faithful — each client heard only
        // its own board); the opponent sim's buffer is drained and discarded.
        // Suppress the burst while catching up a resume backlog.
        if (catchingUp) {
          localSim.drainSoundEvents();
        } else {
          audio.playCues(localSim.drainSoundEvents());
        }
        remoteSim.drainSoundEvents();
      }

      // Big overlay: result image > countdown / GO > lockstep-stall WAITING.
      bigMessage.show(
        resultKind ?? countdownMessage(metaTicks) ?? (wantWaiting ? 'message_waiting' : null),
      );

      const impacts = [localSim.drainImpactEvents(), remoteSim.drainImpactEvents()];
      const dtTicks = Math.min(MAX_SIGN_DT_TICKS, (nowMs - lastMs) / MS_PER_TICK);
      bigMessage.update(dtTicks);
      // End-of-match celebration animation (started on the deciding tick above).
      if (s.outcome) {
        celebAccum += dtTicks;
        let celebSteps = 0;
        while (celebAccum >= 1) {
          celebration.tick();
          celebAccum -= 1;
          celebSteps++;
        }
        bigMessage.setCelebration(celebration.view);
        // Fireworks on the winner's (local, left) board: spawn the drained
        // sparks and advance the board's sparkle sim (the sim itself is frozen).
        if (boards) {
          for (const spawn of celebration.drainSparkSpawns()) {
            boards[0].sparkles.spawnCelebrationSpark(spawn.source, spawn.color);
          }
          boards[0].sparkles.advance(celebSteps);
        }
      }
      const alpha = s.outcome ? 1 : clock.alpha;
      const simsByBoard = [localSim, remoteSim];
      boards.forEach((b, i) => {
        b.signs.update(dtTicks);
        for (const imp of impacts[i]!) b.spring.notifyImpact(imp.height, imp.width);
        for (let t = 0; t < steppedTicks; t++) b.spring.timeStep();
        b.view.setShake(b.spring.offsetCells);
        const sim = simsByBoard[i]!;
        for (const ev of sim.drainSparkEvents())
          b.sparkles.spawnSparks(ev.x, ev.y, ev.flavor, ev.count);
        for (const ev of sim.drainMoteEvents())
          b.sparkles.spawnMote(ev.x, ev.y, ev.level, ev.sibling);
        b.sparkles.advance(steppedTicks);
        b.sparkles.sync();
        const vm = b.interp.sample(alpha);
        b.view.update(vm);
        b.decals.update(vm.garbage);
        b.levelLights.update(lightsTicks, vm.hud.topEffectiveRow, !s.outcome, impacts[i]!);
        b.loseBar.update(steppedTicks, sim.creep.creep_freeze, sim.creep.loss_alarm);
        b.view.render();
        if (i === 0) hud?.update(vm.hud);
      });
    }
    lastMs = nowMs;
    rafId = globalThis.requestAnimationFrame(frame);
  };
  rafId = globalThis.requestAnimationFrame(frame);

  // Mode switch back to solo: tear down and hand control to the caller.
  const soloBtn = $<HTMLButtonElement>('net-solo');
  soloBtn.onclick = (): void => onExit();

  // Kick everything off.
  connect();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      net?.close('mode switch');
      net = null;
      cancelAnimationFrame(rafId);
      globalThis.removeEventListener('keydown', onKeyDown);
      globalThis.removeEventListener('keyup', onKeyUp);
      globalThis.removeEventListener('blur', onBlur);
      globalThis.removeEventListener('resize', fitToWindow);
      if (boards) {
        for (const b of boards) {
          b.loseBar.dispose();
          b.view.dispose(); // release the WebGL contexts (browsers cap them)
          b.container.remove();
        }
        boards = null;
      }
      overlay.remove();
      banner.remove();
      rosterEl.remove();
      titleEl.remove();
      bigMessage.dispose();
      if (hudEl) hudEl.textContent = '';
    },
  };
}
