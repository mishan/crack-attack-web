/**
 * @crack-attack/client — browser entry point.
 *
 * Wires the platform layers around the deterministic core into a playable solo
 * board: a {@link FixedTimestep} advances a `GameSim` at 50 Hz from real time,
 * {@link KeyboardInput} feeds it the player's actions, {@link deriveViewModel}
 * turns each tick's sim state into sprites, {@link ViewInterpolator} smooths the
 * motion between ticks by the render `alpha`, and {@link BoardView} draws it.
 *
 * The page opens in attract mode, like an arcade cabinet: the title card, then
 * hard-vs-hard AI matches behind a PRESS ANY KEY prompt; a key press or click
 * starts play on the solo screen. Solo and netplay are switchable in-client
 * (each mode returns a disposable handle); no URL parameters are required.
 * `?solo` skips attract mode, `?net` force-boots netplay, and `?relay=`
 * overrides the relay URL, for muscle memory and dev convenience. `?demo` boots
 * straight into the interactive AI-vs-AI demo (`?demo=easy,hard` picks the
 * bots) — handy for a showcase link or kiosk.
 *
 * The sim is authoritative and deterministic; everything here is replaceable
 * platform glue (and stays out of `packages/core`, which must not touch the DOM).
 */

import {
  GameSim,
  GC_STEPS_PER_SECOND,
  generateSeed,
  ScoreState,
  SoloRecorder,
  type AiDifficultyLevel,
  type SoloReplay,
} from '@crack-attack/core';
import { normalizeScoreName, type SoloTicketResponse } from '@crack-attack/protocol';
import { pickAiDifficulty } from './render/aiDifficultyPicker.js';
import { pickAiMatchup } from './render/aiMatchupPicker.js';
import { AttractOverlay } from './render/attractOverlay.js';
import { startsPlay } from './view/attract.js';
import {
  NO_WEBGL_MESSAGE,
  START_FAILED_MESSAGE,
  showFatal,
  webglAvailable,
} from './render/fatalMessage.js';
import { parseDemoMatchup } from './view/demoMatchup.js';
import { KeyboardInput } from './input/keyboard.js';
import { mountTouchControls, prefersTouchControls } from './input/touchControls.js';
import { fitBoards, markChrome, onChromeResize, settleBelowChrome } from './render/chrome.js';
import { BoardView, DEFAULT_RENDER_TUNING } from './render/boardView.js';
import { GarbageDecalView } from './render/garbageDecalView.js';
import { HudView } from './render/hudView.js';
import { LevelLightsView } from './render/levelLightsView.js';
import { SignsView } from './render/signsView.js';
import { MessageOverlay } from './render/messageOverlay.js';
import { SparklesView } from './render/sparklesView.js';
import { FixedTimestep } from './sim/fixedTimestep.js';
import { deriveViewModel } from './view/boardViewModel.js';
import { COUNTDOWN_GATE_TICKS, countdownMessage } from './view/messages.js';
import { Celebration } from './view/celebration.js';
import { Spring } from './view/spring.js';
import { ViewInterpolator } from './view/viewInterpolator.js';
import { AudioManager } from './audio/audioManager.js';
import { mountAudioControls } from './audio/audioControls.js';
import { humanRank, insertMult, insertScore } from './view/scoreRecords.js';
import {
  hasPlayerName,
  loadMultRecords,
  loadPlayerName,
  loadRankedPlay,
  loadScoreRecords,
  saveMultRecords,
  savePlayerName,
  saveRankedPlay,
  saveScoreRecords,
} from './score/scoreStore.js';
import { createRankedServices, type RankedServices } from './score/rankedServices.js';
import { promptScoreName } from './render/namePrompt.js';
import {
  NOT_SUBMITTED_LINE,
  RETRY_LINE,
  VERIFYING_LINE,
  rejectionLine,
  runTag,
  standingLine,
  type RunKind,
} from './view/ranked.js';

const MS_PER_TICK = 1000 / GC_STEPS_PER_SECOND;
/** Cap sign advance per frame so a long stall (tab refocus) doesn't warp them away. */
const MAX_SIGN_DT_TICKS = 10;

const SOLO_HELP = '←→↑↓ move · Z / Space swap · X raise · R restart · P pause · M mute';
const AI_HELP = '←→↑↓ move · Z / Space swap · X raise · R restart · P pause · M mute · vs AI';
const NET_HELP =
  '←→↑↓ move · Z / Space swap · X raise · R ready/rematch · Esc concede/stop watching · M mute';
const DEMO_HELP = 'AI vs AI demo · N next match · F speed · P pause · M mute · Esc leave';
const ATTRACT_HELP = 'AI vs AI demo · press any key or click to play · M mute';
const SCORES_HELP = 'High scores · Esc back · M mute';
/** How long the first ranked game of a page load waits for its ticket before starting unranked. */
const FIRST_TICKET_WAIT_MS = 1000;

/** A running mode (solo board or netplay shell); dispose to switch away. */
interface ModeHandle {
  dispose(): void;
}

// Every mode but solo lives in its own chunk, fetched on demand, so first load
// only pays for the solo board (the AI planner, for one, ships with the AI
// modes). Opening a picker starts the fetch, so the chunk has usually arrived
// by the time a choice is made.
const loadAiMatch = () => import('./aiMatch.js');
const loadAiDemo = () => import('./aiDemo.js');
const loadNetplay = () => import('./netplay.js');
const loadHighScores = () => import('./highScores.js');
/** Warm a lazy chunk; a failure here resurfaces (and is handled) when the mode boots. */
const prefetch = (load: () => Promise<unknown>): void => void load().catch(() => {});

/**
 * Where the relay lives, in priority order: `?relay=` (dev convenience) →
 * `VITE_RELAY_URL` (baked at build time — the deployment story, e.g.
 * `wss://example.com/ws` behind a reverse proxy) → same host on the default
 * port, with the scheme following the page's security context (an https page
 * can only open wss sockets under mixed-content rules).
 */
function resolveRelayUrl(params: URLSearchParams): string {
  const fromParam = params.get('relay');
  if (fromParam) return fromParam;
  const fromEnv = import.meta.env['VITE_RELAY_URL'] as string | undefined;
  if (fromEnv) return fromEnv;
  const scheme = globalThis.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${globalThis.location.hostname}:8080`;
}

/** Whether an event target is a form control or editable element (keys should pass through). */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function boot(): void {
  // Everything renders through WebGL 2 (three.js); without it, say so rather
  // than leave a blank page.
  if (!webglAvailable()) {
    showFatal(NO_WEBGL_MESSAGE);
    return;
  }
  const app = document.getElementById('app');
  const hudEl = document.getElementById('hud');
  if (!app) throw new Error('missing #app container');

  const params = new URLSearchParams(globalThis.location.search);
  const relayUrl = resolveRelayUrl(params);
  const help = document.getElementById('help');

  // Ranked solo play: the scoreboard lives on the relay's host. Fetch the first
  // run ticket now, so it's in hand by the time a game starts, and send any
  // run left waiting from an earlier visit. With ranked play off, nothing
  // touches the network; waiting runs keep until it's turned back on.
  const ranked = createRankedServices(relayUrl);
  if (ranked && loadRankedPlay()) {
    ranked.tickets.refill();
    ranked.flush();
  }

  // One AudioManager spans both modes so music and settings survive a switch.
  // Browsers gate audio behind a gesture: unlock on the first key/pointer, and
  // pause music while the tab is hidden (C++ Music::pause/resume on GS_PAUSED).
  const audio = new AudioManager();
  const audioUi = mountAudioControls(audio);
  audio.playPrelude(); // menu music; starts once the first gesture unlocks audio
  // Unlock on user gestures. Listeners stay attached (not one-shot): unlock() is
  // cheap and idempotent, and keeping them means a later autoplay/resume
  // rejection (e.g. after tab backgrounding) can recover on the next gesture by
  // resuming a suspended context and retrying any queued track.
  const onGesture = (): void => audio.unlock();
  globalThis.addEventListener('pointerdown', onGesture);
  globalThis.addEventListener('keydown', onGesture);
  globalThis.addEventListener('keydown', (e) => {
    // Ignore auto-repeat (holding M is one toggle) and keys typed into a form
    // control / editable element (sliders, future text inputs) so adjusting
    // settings doesn't accidentally mute.
    if (e.code === 'KeyM' && !e.repeat && !isTypingTarget(e.target)) {
      audio.toggleMuted();
      audioUi.syncMuted();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) audio.pauseMusic();
    else audio.resumeMusic();
  });

  let current: ModeHandle | null = null;
  // Chosen from the difficulty modal; drives an `enter('ai')`.
  let aiDifficulty: AiDifficultyLevel = 'medium';
  // The AI-vs-AI demo's bots; seeded from `?demo=`, then the last picker choice.
  let demoMatchup = parseDemoMatchup(params.get('demo'));

  // Open the difficulty modal, then boot a vs-AI match (or stay put if cancelled).
  const playAi = (): void => {
    prefetch(loadAiMatch);
    void pickAiDifficulty().then((diff) => {
      if (!diff) return;
      aiDifficulty = diff;
      enter('ai');
    });
  };

  // Pick the two bots, then boot the AI-vs-AI demo (or stay put if cancelled).
  const watchAi = (): void => {
    prefetch(loadAiDemo);
    void pickAiMatchup(demoMatchup).then((matchup) => {
      if (!matchup) return;
      demoMatchup = matchup;
      enter('demo');
    });
  };

  // Bumped on every switch, so a lazy mode whose chunk lands after the user has
  // already moved on is dropped instead of booting on top of the new mode.
  let modeGen = 0;
  // A mode that throws while starting (almost always WebGL: the browser refused
  // a new context) gets an explanation instead of a frozen screen.
  const startFailed = (err: unknown): void => {
    console.error('failed to start mode', err);
    showFatal(START_FAILED_MESSAGE);
  };
  const bootLazy = <M>(load: () => Promise<M>, start: (m: M) => ModeHandle): void => {
    const gen = modeGen;
    load().then(
      (m) => {
        if (gen !== modeGen) return;
        try {
          current = start(m);
        } catch (err) {
          startFailed(err);
        }
      },
      (err: unknown) => {
        // Typically a stale tab after a redeploy (the old chunk is gone). Fall
        // back to solo, which is in the entry bundle.
        console.error('failed to load mode', err);
        if (gen === modeGen) enter('solo');
      },
    );
  };

  // Attract mode: the title card (from the entry bundle, so it shows at once),
  // then the AI-vs-AI demo behind it once its chunk lands. A key press or a
  // click on the boards or title starts play; the audio controls stay usable.
  const bootAttract = (toSolo: () => void): void => {
    const attract = new AttractOverlay(prefersTouchControls());
    const onKeyDown = (e: KeyboardEvent): void => {
      // Space/Enter on a focused button (e.g. mute) activate it rather than start.
      const onControl = e.target instanceof Element && e.target.closest('button, a[href]') !== null;
      const { code, repeat, ctrlKey, metaKey, altKey } = e;
      if (isTypingTarget(e.target)) return;
      if (!startsPlay({ code, repeat, ctrlKey, metaKey, altKey, onControl })) return;
      e.preventDefault();
      toSolo();
    };
    const onClick = (e: MouseEvent): void => {
      const t = e.target;
      if (t instanceof Node && (app.contains(t) || attract.contains(t))) toSolo();
    };
    globalThis.addEventListener('keydown', onKeyDown);
    globalThis.addEventListener('click', onClick);
    const teardown = (): void => {
      globalThis.removeEventListener('keydown', onKeyDown);
      globalThis.removeEventListener('click', onClick);
      attract.dispose();
    };
    current = { dispose: teardown }; // until the demo lands
    // The title card doubles as the high-score table: this month's best runs
    // (not with ranked play off, which keeps the game off the network).
    if (loadRankedPlay()) {
      void ranked?.client.scores({ period: 'month', limit: 5 }).then(
        (res) => attract.setHighScores('THIS MONTH', res.entries),
        () => undefined, // unreachable: just the logo
      );
    }
    const { left, right } = demoMatchup;
    bootLazy(loadAiDemo, (m) => {
      const demo = m.bootAiDemo(app, hudEl, left, right, audio, toSolo, attract);
      return {
        dispose(): void {
          demo.dispose();
          teardown();
        },
      };
    });
  };

  const HELP = {
    attract: ATTRACT_HELP,
    solo: SOLO_HELP,
    net: NET_HELP,
    ai: AI_HELP,
    demo: DEMO_HELP,
    scores: SCORES_HELP,
  };
  const enter = (mode: 'attract' | 'solo' | 'net' | 'ai' | 'demo' | 'scores'): void => {
    current?.dispose();
    current = null;
    modeGen++;
    if (hudEl) hudEl.textContent = '';
    if (help) help.textContent = HELP[mode];
    const toSolo = (): void => enter('solo');
    try {
      if (mode === 'attract') {
        bootAttract(toSolo);
      } else if (mode === 'net') {
        bootLazy(loadNetplay, (m) => m.bootNetplay(app, hudEl, relayUrl, toSolo, audio));
      } else if (mode === 'ai') {
        bootLazy(loadAiMatch, (m) => m.bootAiMatch(app, hudEl, aiDifficulty, audio, toSolo));
      } else if (mode === 'demo') {
        const { left, right } = demoMatchup;
        bootLazy(loadAiDemo, (m) => m.bootAiDemo(app, hudEl, left, right, audio, toSolo));
      } else if (mode === 'scores') {
        bootLazy(loadHighScores, (m) => m.bootHighScores(ranked?.client ?? null, toSolo));
      } else {
        current = bootSolo(
          app,
          hudEl,
          () => enter('net'),
          playAi,
          watchAi,
          () => enter('scores'),
          audio,
          ranked,
        );
      }
    } catch (err) {
      startFailed(err);
    }
  };

  enter(
    params.has('demo')
      ? 'demo'
      : params.has('net')
        ? 'net'
        : params.has('scores')
          ? 'scores'
          : params.has('solo')
            ? 'solo'
            : 'attract',
  );
  // Booted: drop the placeholder (a failed start has already replaced it).
  document.getElementById('loading')?.remove();
}

function bootSolo(
  app: HTMLElement,
  hudEl: HTMLElement | null,
  onPlayOnline: () => void,
  onPlayAi: () => void,
  onWatchAi: () => void,
  onHighScores: () => void,
  audio: AudioManager,
  ranked: RankedServices | null,
): ModeHandle {
  // --- ranked play (docs/SCOREBOARD_PLAN.md) -------------------------------
  let rankedOn = loadRankedPlay();
  /** The current run: what kind it is, and its ticket while it's ranked. */
  let run: { kind: RunKind; ticket: SoloTicketResponse | null } = {
    kind: 'practice',
    ticket: null,
  };
  /** Bumped every game, so a late name prompt can tell its game has moved on. */
  let gameNo = 0;
  /** This game's submitted ranked run, whose result the HUD is waiting for. */
  let awaitingRunId: string | null = null;
  /**
   * A fresh board every game, as the reference seeds each run
   * (`Random::seed(Random::generateSeed())`, Attack.cxx:143) — from a
   * server-issued ticket when the run is ranked, since the seed decides the board.
   */
  const nextSeed = (): number => {
    gameNo++;
    awaitingRunId = null;
    if (!rankedOn) {
      run = { kind: 'practice', ticket: null };
      return generateSeed();
    }
    const got = ranked ? ranked.tickets.take() : ({ reason: 'offline' } as const);
    if ('ticket' in got) {
      run = { kind: 'ranked', ticket: got.ticket };
      return got.ticket.seed;
    }
    run = { kind: got.reason, ticket: null };
    return generateSeed();
  };
  // The first ranked game of a page load can beat its ticket here: hold the
  // board, hidden, for up to a second rather than start it unranked.
  let waitUntil: number | null =
    rankedOn && ranked && !ranked.tickets.ready && ranked.tickets.fetching
      ? performance.now() + FIRST_TICKET_WAIT_MS
      : null;
  let seed = waitUntil === null ? nextSeed() : generateSeed();
  let sim = new GameSim(seed);
  // Every run is recorded (seed + input changes), so it can be saved or replayed.
  let recorder = new SoloRecorder(seed);
  const clock = new FixedTimestep();
  const input = new KeyboardInput();
  const interp = new ViewInterpolator();
  // One grid walk to read the board dimensions and seed the interpolator.
  const initial = deriveViewModel(sim);
  interp.push(initial);
  const view = new BoardView(app, initial.width, initial.visibleHeight);
  const halfW = (initial.width - 1) / 2;
  const halfH = (initial.visibleHeight - 1) / 2;
  const signs = new SignsView(view.scene, halfW, halfH);
  const decals = new GarbageDecalView(view.scene, halfW, halfH);
  const levelLights = new LevelLightsView(view.scene, halfW, halfH);
  const sparkles = new SparklesView(view.scene, halfW, halfH);
  const spring = new Spring();
  const overlay = new MessageOverlay(app);
  // Solo shows the lose bar in the HUD, where the original's side column had it.
  const hud = hudEl ? new HudView(hudEl, { loseBar: true }) : null;
  let disposed = false;
  let rafId = 0;
  /** Ticks since game start, counting the held countdown gate. */
  let metaTicks = 0;
  /** Solo pause (GS_PAUSED): the sim freezes and a PAUSED overlay shows. */
  let paused = false;
  // End-of-match celebration: on a loss the board dims and GAME OVER drops in
  // and bounces (CelebrationManager). Runs on wall-clock ticks after the sim
  // freezes; `celebAccum` carries the fractional-tick remainder between frames.
  const celebration = new Celebration();
  let celebAccum = 0;
  // Audio lifecycle for this game: game music starts at GO, the game-over stinger
  // on loss (each fired once). Mirrors the C++ CountDownManager/CelebrationManager
  // music transitions.
  let gameMusicOn = false;
  let endMusicOn = false;
  audio.resetCountdown();
  // Fade the menu prelude over the first 3-2-1 (C++ gameStart → Music::fadeout),
  // matching restart(); game music takes over at GO.
  audio.fadeoutMusic(3000);
  levelLights.reset(initial.hud.topEffectiveRow);

  // --- solo scoring (display layer; Score.cxx) -----------------------------
  const score = new ScoreState();
  let scoreSubmitted = false;
  /** The current best (top) high score, for the "BEST" readout. */
  const bestScore = (): number => {
    const table = loadScoreRecords();
    return table[table.length - 1]?.score ?? 0;
  };
  const showBest = (): void => hud?.setScoreRecord(`BEST ${bestScore()}`);
  hud?.updateScore(score.formatted());
  showBest();
  /** The HUD's run line: what kind of run this is (blank while holding for a ticket). */
  const showRunTag = (): void =>
    hud?.setRunLine(
      waitUntil === null ? runTag(run.kind) : '',
      run.kind === 'ranked' ? 'good' : 'normal',
    );
  showRunTag();

  // A ranked run's result replaces the tag once the scoreboard answers.
  const stopListening = ranked?.outbox.listen((runId, outcome) => {
    if (runId !== awaitingRunId) return;
    if (outcome.ok) hud?.setRunLine(standingLine(outcome.response), 'good');
    else if (outcome.kept) hud?.setRunLine(RETRY_LINE);
    else hud?.setRunLine(rejectionLine(outcome.error.code), 'bad');
  });

  /** Queue a finished ranked run for the scoreboard, asking for a name the first time. */
  const submitRanked = (ticket: SoloTicketResponse, replay: SoloReplay): void => {
    if (!ranked) return;
    const game = gameNo;
    const send = (name: string): void => {
      ranked.outbox.add({
        request: { runId: ticket.runId, name, replay },
        expiresAt: ticket.expiresAt,
      });
      if (game === gameNo) {
        awaitingRunId = ticket.runId;
        hud?.setRunLine(VERIFYING_LINE);
      }
      ranked.flush();
    };
    // A saved name (maybe from the lobby, which only checks length) must
    // survive the scoreboard's cleanup; if nothing usable is left, ask.
    const saved = hasPlayerName() ? normalizeScoreName(loadPlayerName()) : null;
    if (saved !== null) {
      send(saved);
      return;
    }
    void promptScoreName().then((name) => {
      if (name === null) {
        if (game === gameNo) hud?.setRunLine(NOT_SUBMITTED_LINE);
        return;
      }
      savePlayerName(name);
      send(name);
    });
  };

  /** On a loss, fold points into the score and record any new high score / multiplier. */
  const submitScore = (): void => {
    if (scoreSubmitted) return;
    scoreSubmitted = true;
    score.flush();
    hud?.updateScore(score.formatted());

    const name = loadPlayerName();
    const scoreRes = insertScore(loadScoreRecords(), name, score.score);
    if (scoreRes.rank >= 0) saveScoreRecords(scoreRes.records);
    const multRes = insertMult(loadMultRecords(), name, score.topMultiplier);
    if (multRes.rank >= 0) saveMultRecords(multRes.records);

    if (scoreRes.rank >= 0) {
      hud?.setScoreRecord(
        `NEW HIGH SCORE — rank #${humanRank(scoreRes.rank, scoreRes.records.length)}`,
      );
    } else {
      showBest();
    }

    if (run.kind === 'ranked' && run.ticket) submitRanked(run.ticket, recorder.replay());
  };

  // Temporary lighting/material tuner — open with `?tune` in the URL.
  // A dev aid, so it's its own chunk rather than part of first load.
  if (new URLSearchParams(globalThis.location.search).has('tune')) {
    void import('./render/renderTuner.js').then((m) => {
      if (!disposed) m.mountRenderTuner(view, DEFAULT_RENDER_TUNING);
    });
  }

  // First fit runs once the touch controls are up (below), so it frames around them.
  const fitToWindow = (): void => {
    if (hudEl) settleBelowChrome(hudEl);
    fitBoards([{ container: app, view }]);
  };
  globalThis.addEventListener('resize', fitToWindow);

  // Mode switch into netplay.
  const onlineBtn = document.createElement('button');
  onlineBtn.textContent = 'Play online';
  onlineBtn.style.cssText =
    'position:fixed;top:12px;right:12px;z-index:5;padding:6px 12px;opacity:.85';
  onlineBtn.onclick = onPlayOnline;
  document.body.appendChild(markChrome(onlineBtn));

  // Mode switch into a local vs-AI match (two visible boards). Stacked directly
  // below "Play online" on the far right; the audio controls live at right:120px,
  // so the right:12px column stays clear of them.
  const aiBtn = document.createElement('button');
  aiBtn.textContent = 'Play vs AI';
  aiBtn.style.cssText = 'position:fixed;top:52px;right:12px;z-index:5;padding:6px 12px;opacity:.85';
  aiBtn.onclick = onPlayAi;
  document.body.appendChild(markChrome(aiBtn));

  // Mode switch into the AI-vs-AI demo, third in the same column.
  const demoBtn = document.createElement('button');
  demoBtn.textContent = 'Watch AI vs AI';
  demoBtn.style.cssText =
    'position:fixed;top:92px;right:12px;z-index:5;padding:6px 12px;opacity:.85';
  demoBtn.onclick = onWatchAi;
  document.body.appendChild(markChrome(demoBtn));

  // The online high-score boards, fourth in the column.
  const scoresBtn = document.createElement('button');
  scoresBtn.textContent = 'High scores';
  scoresBtn.style.cssText =
    'position:fixed;top:132px;right:12px;z-index:5;padding:6px 12px;opacity:.85';
  scoresBtn.onclick = onHighScores;
  document.body.appendChild(markChrome(scoresBtn));

  // Ranked play on/off, fifth. Off makes every run practice (no tickets, no
  // submissions); turning it off mid-run unranks that run at once, while
  // turning it on applies from the next game (the board's seed is already set).
  const rankedBtn = document.createElement('button');
  rankedBtn.style.cssText =
    'position:fixed;top:172px;right:12px;z-index:5;padding:6px 12px;opacity:.85';
  const showRankedBtn = (): void => {
    rankedBtn.textContent = rankedOn ? 'Ranked: on' : 'Ranked: off';
    rankedBtn.setAttribute('aria-pressed', String(rankedOn));
    rankedBtn.title = rankedOn
      ? 'Runs go on the online high-score boards'
      : 'Practice: runs stay off the online boards';
  };
  showRankedBtn();
  rankedBtn.onclick = () => {
    rankedBtn.blur(); // so Space (swap) doesn't toggle it again
    rankedOn = !rankedOn;
    saveRankedPlay(rankedOn);
    showRankedBtn();
    if (rankedOn) {
      ranked?.tickets.refill();
      ranked?.flush(); // runs held while ranked play was off
    } else if (run.kind === 'ranked' && !sim.lost) {
      run = { kind: 'practice', ticket: null };
      showRunTag();
    }
  };
  document.body.appendChild(markChrome(rankedBtn));

  // Appears once the game is over, last in the column: download the run as a
  // solo replay (seed + inputs; core `verifySoloReplay` re-scores it).
  const saveReplay = (): void => {
    const replay = { kind: 'crack-attack-solo-replay', ...recorder.replay() };
    const blob = new Blob([JSON.stringify(replay)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `replay-solo-${replay.seed}.json`;
    link.click();
    // Revoking synchronously can cancel the download in some browsers — give
    // the navigation ample time to start before releasing the blob.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save replay';
  saveBtn.style.cssText =
    'position:fixed;top:212px;right:12px;z-index:5;padding:6px 12px;opacity:.85;display:none';
  saveBtn.onclick = saveReplay;
  document.body.appendChild(markChrome(saveBtn));

  // --- input ---------------------------------------------------------------
  const restart = (): void => {
    // A restart (R, or the touch button) during the first game's ticket hold
    // ends the hold; otherwise the loop would restart again once it lapsed.
    waitUntil = null;
    seed = nextSeed(); // a restart abandons a ranked run: its ticket is dropped
    sim = new GameSim(seed); // fresh game on a new board
    recorder = new SoloRecorder(seed);
    clock.reset();
    interp.reset();
    const fresh = deriveViewModel(sim);
    interp.push(fresh);
    signs.clear();
    decals.clear();
    sparkles.clear();
    input.clear();
    spring.gameStart();
    view.setShake(0);
    levelLights.reset(fresh.hud.topEffectiveRow);
    hud?.loseBar?.reset();
    metaTicks = 0;
    // Fade the ending stinger over the new countdown, then game music at GO
    // (C++ gameStart → Music::fadeout(3000); GO → Music::play).
    gameMusicOn = false;
    endMusicOn = false;
    audio.resetCountdown();
    audio.fadeoutMusic(3000);
    paused = false;
    celebration.stop();
    celebAccum = 0;
    overlay.setCelebration(null);
    // Reset scoring for the new game.
    score.reset();
    scoreSubmitted = false;
    hud?.updateScore(score.formatted());
    showBest();
    showRunTag();
    if (rankedOn) ranked?.flush(); // retry any run still waiting on the scoreboard
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    // Keys typed into the name prompt, or pressing its buttons (Space), are
    // the dialog's, not the game's.
    const inDialog = e.target instanceof Element && e.target.closest('[role="dialog"]') !== null;
    if (isTypingTarget(e.target) || inDialog) return;
    if (e.code === 'KeyR') {
      restart();
      return;
    }
    if (e.code === 'KeyP' && !e.repeat) {
      // Toggle solo pause (Game::buttonPause). You can't pause once the game is
      // over, during the 3-2-1 countdown, or when you're about to lose
      // (creep_freeze) — Game.cxx:214.
      if (!paused) {
        if (sim.lost || sim.creep.creep_freeze || metaTicks < COUNTDOWN_GATE_TICKS) return;
        paused = true;
        audio.pauseMusic();
      } else {
        paused = false;
        audio.resumeMusic();
      }
      return;
    }
    if (input.handles(e.code)) {
      input.press(e.code);
      e.preventDefault();
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => input.release(e.code);
  // Don't let inputs stick if focus leaves the tab mid-press.
  const onBlur = (): void => input.clear();
  globalThis.addEventListener('keydown', onKeyDown);
  globalThis.addEventListener('keyup', onKeyUp);
  globalThis.addEventListener('blur', onBlur);

  // On-screen controls for touch devices; they feed the same KeyboardInput.
  const touch = mountTouchControls({
    press: (code) => input.press(code),
    release: (code) => input.release(code),
    restart,
  });
  // The keyboard hint is useless on a phone — hide it when touch controls mount.
  if (touch) {
    const help = document.getElementById('help');
    if (help) help.style.display = 'none';
  }
  fitToWindow();
  const stopWatchingChrome = onChromeResize(fitToWindow);

  // A ranked run's board is hidden while paused, so a pause can't be used to
  // study it; so is the board held back for its first ticket.
  let boardShown = true;
  const syncBoardShown = (): void => {
    const shown = waitUntil === null && !(paused && run.kind === 'ranked');
    if (shown === boardShown) return;
    boardShown = shown;
    view.renderer.domElement.style.visibility = shown ? '' : 'hidden';
  };
  syncBoardShown();

  // --- loop ----------------------------------------------------------------
  let lastMs = performance.now();
  const frame = (nowMs: number): void => {
    if (disposed) return;
    if (waitUntil !== null) {
      // Holding the first board for its ticket: start once it arrives, the
      // request fails, or the wait runs out.
      clock.sample(nowMs);
      if (!ranked?.tickets.fetching || nowMs >= waitUntil) {
        waitUntil = null;
        restart();
      }
      syncBoardShown();
      rafId = globalThis.requestAnimationFrame(frame);
      return;
    }
    // Advance the sim only while the game is live. On a loss we stop stepping, so
    // the clock (and thus the HUD timer) and the board freeze on the final tick
    // until the player restarts.
    let stepped = 0;
    let gateTicks = 0; // wall ticks the countdown gate consumed this frame
    if (paused) {
      // Freeze the sim, but consume wall-clock time so unpausing doesn't
      // burst-catch-up. Everything below renders the frozen board + PAUSED.
      clock.sample(nowMs);
    } else if (!sim.lost) {
      const steps = clock.sample(nowMs);
      for (let s = 0; s < steps; s++) {
        // Countdown gate: the whole gameplay step is held for the first
        // GC_START_PAUSE_DELAY ticks (Game.cxx:399-408) while 3-2-1 shows.
        if (metaTicks < COUNTDOWN_GATE_TICKS) {
          metaTicks++;
          gateTicks++;
          continue;
        }
        const act = input.actionState();
        recorder.record(act.state);
        sim.step(act);
        stepped++;
        metaTicks++;
        // Interpolation only needs the last two ticks, so under catch-up (steps > 1)
        // skip the expensive grid-walk for the intermediate ticks that get
        // discarded — but always capture the tick a loss lands on.
        if (s >= steps - 2 || sim.lost) interp.push(deriveViewModel(sim));
        if (sim.lost) break;
      }
      // Spawn reward signs for the combos that fired across this frame's ticks.
      for (const ev of sim.drainSignEvents()) signs.spawn(ev.gridX, ev.gridY, ev.kind, ev.level);
    }

    // Audio: countdown beeps track the meta timeline; game music starts at GO.
    audio.updateCountdown(metaTicks);
    if (!gameMusicOn && metaTicks >= COUNTDOWN_GATE_TICKS) {
      gameMusicOn = true;
      audio.playGame(); // C++ CountDownManager GO → Music::stop + Music::play
    }
    // Gameplay sound cues (landings, pops, deaths, shatters) for this frame.
    audio.playCues(sim.drainSoundEvents());
    // The game-over stinger on the tick a loss lands (C++ CelebrationManager).
    if (sim.lost && !endMusicOn) {
      endMusicOn = true;
      audio.playGameOver();
    }

    // Scoring: fold in this frame's eliminations, then drip the backlog into the
    // shown total on the ticks that actually played (Score::timeStepPlay).
    for (const ev of sim.drainScoreEvents()) score.report(ev);
    score.timeStep(stepped);
    hud?.updateScore(score.formatted());
    if (sim.lost) submitScore();
    saveBtn.style.display = sim.lost ? '' : 'none';

    // Cosmetic garbage-landing impacts: kick the shake spring and flash the
    // lights; both tick with the sim (they freeze when it does).
    const impacts = sim.drainImpactEvents();
    for (const imp of impacts) spring.notifyImpact(imp.height, imp.width);
    for (let t = 0; t < stepped; t++) spring.timeStep();
    view.setShake(spring.offsetCells);

    // Lose bar (in the HUD): tracks the Creep loss countdown, ticking with the sim
    // (only in play, so pass `stepped`, not the gate ticks — LoseBar::timeStep is
    // post-gate).
    hud?.loseBar?.update(stepped, sim.creep.creep_freeze, sim.creep.loss_alarm);

    // Death sparks + reward motes, ticking with the sim like the spring.
    for (const ev of sim.drainSparkEvents()) sparkles.spawnSparks(ev.x, ev.y, ev.flavor, ev.count);
    for (const ev of sim.drainMoteEvents()) sparkles.spawnMote(ev.x, ev.y, ev.level, ev.sibling);
    sparkles.advance(stepped);
    sparkles.sync();

    // Signs float on wall-clock time (and keep fading out after a loss).
    const dtTicks = Math.min(MAX_SIGN_DT_TICKS, (nowMs - lastMs) / MS_PER_TICK);
    lastMs = nowMs;
    signs.update(dtTicks);

    // After a loss show the frozen final tick (alpha 1) rather than interpolating
    // toward a state the sim will never reach.
    // Big overlay: GAME OVER once lost, PAUSED while paused, else countdown / GO.
    overlay.show(
      sim.lost ? 'message_game_over' : paused ? 'message_paused' : countdownMessage(metaTicks),
    );
    overlay.update(dtTicks);

    // End-of-match celebration: dim the board and bounce GAME OVER in on a loss.
    if (sim.lost) {
      if (!celebration.active) celebration.start('loss');
      celebAccum += dtTicks;
      while (celebAccum >= 1) {
        celebration.tick();
        celebAccum -= 1;
      }
      overlay.setCelebration(celebration.view);
    }

    // Freeze the board on the latest tick while paused (or lost); else interpolate.
    const vm = interp.sample(sim.lost || paused ? 1 : clock.alpha);
    view.update(vm);
    decals.update(vm.garbage);
    // Lights tick through the countdown gate too (Game.cxx:389 runs before
    // the gate check) — the start-of-game fade completes exactly at GO.
    levelLights.update(gateTicks + stepped, vm.hud.topEffectiveRow, !sim.lost, impacts);
    syncBoardShown();
    view.render();
    hud?.update(vm.hud);

    rafId = globalThis.requestAnimationFrame(frame);
  };
  rafId = globalThis.requestAnimationFrame(frame);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(rafId);
      globalThis.removeEventListener('resize', fitToWindow);
      stopWatchingChrome();
      globalThis.removeEventListener('keydown', onKeyDown);
      globalThis.removeEventListener('keyup', onKeyUp);
      globalThis.removeEventListener('blur', onBlur);
      touch?.remove();
      onlineBtn.remove();
      aiBtn.remove();
      demoBtn.remove();
      scoresBtn.remove();
      rankedBtn.remove();
      saveBtn.remove();
      stopListening?.();
      overlay.dispose();
      view.dispose(); // release the WebGL context (browsers cap them)
    },
  };
}

try {
  boot();
} catch (err) {
  console.error('failed to boot', err);
  showFatal(START_FAILED_MESSAGE);
}
