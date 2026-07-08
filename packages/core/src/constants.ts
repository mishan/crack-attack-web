/**
 * constants.ts
 *
 * Gameplay constants transcribed verbatim from the original C++ source
 * (`crack-attack/src/Game.h`). Values here define the deterministic simulation
 * and MUST match the C++ build exactly — do not "clean up" numbers.
 *
 * Only simulation-relevant constants are ported. Rendering/UI constants
 * (resolutions, sine tables, texture paths, key bindings, GL/GTK details) live
 * in the client layer, not here.
 *
 * Source references are given as `Game.h:<line>` against Crack Attack! v1.1.15.
 *
 * Original work Copyright (C) 2000 Daniel Nelson, (C) 2004 Andrew Sayman.
 * Licensed GPL-2.0-or-later.
 */

// --- Match structure -------------------------------------------------------

/** Games per match (best-of). `Game.h:140` */
export const GC_GAMES_PER_MATCH = 3;

// --- Play area geometry ----------------------------------------------------

/** Grid width in columns. `Game.h:143` */
export const GC_PLAY_WIDTH = 6;
/** Grid height in rows (tall to give falling/garbage headroom). `Game.h:144` */
export const GC_PLAY_HEIGHT = 45;
/** Safe height; `GC_SAFE_HEIGHT - 1` is the visible board height. Crossing it
 *  starts the loss countdown. `Game.h:145` */
export const GC_SAFE_HEIGHT = 13;
/** Total grid cells. `Game.h:146` */
export const GC_GRID_SIZE = GC_PLAY_WIDTH * GC_PLAY_HEIGHT;

// --- Fixed-size object stores ----------------------------------------------

/** Max live blocks. `Game.h:149` */
export const GC_BLOCK_STORE_SIZE = GC_GRID_SIZE;
/** Max live garbage objects. `Game.h:150` */
export const GC_GARBAGE_STORE_SIZE = 2 * GC_PLAY_HEIGHT;
/** Combo tabulator pool size. `Game.h:151` */
export const GC_COMBO_TABULATOR_STORE_SIZE = 8;
/** Outbound garbage queue capacity. `Game.h:152` */
export const GC_GARBAGE_QUEUE_SIZE = 8;

// --- Timing (the fixed-timestep heartbeat) ---------------------------------

/** Logic ticks per second. The whole sim is expressed in these steps. `Game.h:155` */
export const GC_STEPS_PER_SECOND = 50;
/** Milliseconds per logic tick (20 ms). `Game.h:158` */
export const GC_TIME_STEP_PERIOD = Math.trunc(1000 / GC_STEPS_PER_SECOND);
/** Sub-cell position resolution: subdivisions per grid cell. `Game.h:161` */
export const GC_STEPS_PER_GRID = 60;

// --- Falling / swapping ----------------------------------------------------

/** Fall speed in sub-cell units per tick; must divide GC_STEPS_PER_GRID. `Game.h:172` */
export const GC_FALL_VELOCITY = 20;
/** Swap animation speed in sub-cell units per tick. `Game.h:175` */
export const GC_SWAP_VELOCITY = 10;
/** Ticks a swap takes (GC_STEPS_PER_GRID / GC_SWAP_VELOCITY = 6). `Game.h:176` */
export const GC_SWAP_DELAY = Math.trunc(GC_STEPS_PER_GRID / GC_SWAP_VELOCITY);

// --- Creep (the rising stack) ----------------------------------------------

/** Base creep delay. `Game.h:179` */
export const GC_CREEP_DELAY = 1200;
/** Timer step added on manual advance. `Game.h:180` */
export const GC_CREEP_ADVANCE_TIMER_STEP = GC_CREEP_DELAY;
/** Amount the creep timer step grows each increment. `Game.h:181` */
export const GC_CREEP_TIMER_STEP_INCREMENT = 20;
/** Initial creep timer step. `Game.h:182` */
export const GC_CREEP_INITIAL_TIMER_STEP = GC_CREEP_TIMER_STEP_INCREMENT;
/** Creep timer step cap. `Game.h:183` */
export const GC_CREEP_MAX_TIMER_STEP = 2400;
/** Sub-cell creep speed on manual advance. `Game.h:184` */
export const GC_CREEP_ADVANCE_VELOCITY = 3;
/** Ticks between creep-speed increments (10 s). `Game.h:185` */
export const GC_CREEP_INCREMENT_DELAY = 10 * GC_STEPS_PER_SECOND;

// --- Loss timing -----------------------------------------------------------

/** Ticks between safe-height violation and loss (7 s). `Game.h:188` */
export const GC_LOSS_DELAY = 7 * GC_STEPS_PER_SECOND;
/** Shorter loss delay used during elimination (1 s). `Game.h:189` */
export const GC_LOSS_DELAY_ELIMINATION = 1 * GC_STEPS_PER_SECOND;

// --- Block state timing ----------------------------------------------------

/** Ticks between cursor moves while a direction is held. `Game.h:192` */
export const GC_MOVE_DELAY = 6;
/** Ticks a block spends dying (popping animation window). `Game.h:195` */
export const GC_DYING_DELAY = 90;
/** Ticks a block hangs before it starts to fall. `Game.h:198` */
export const GC_HANG_DELAY = 3;
/** Ticks between successive pops within a match. `Game.h:201` */
export const GC_INTERNAL_POP_DELAY = 15;
/** Ticks before the first pop of a match (50 + internal). `Game.h:202` */
export const GC_INITIAL_POP_DELAY = 50 + GC_INTERNAL_POP_DELAY;
/** Ticks after the last pop. `Game.h:203` */
export const GC_FINAL_POP_DELAY = 50;

// --- Matching --------------------------------------------------------------

/** Minimum run length for an elimination. `Game.h:206` */
export const GC_MIN_PATTERN_LENGTH = 3;

// --- Special block / garbage chances ---------------------------------------

/** 1-in-N chance a creep row has NO special block (normal mode). `Game.h:209` */
export const GC_NO_SPECIAL_BLOCK_CHANCE_IN = 3;
/** 1-in-N chance a creep row has NO special block (X mode). `Game.h:210` */
export const GC_X_NO_SPECIAL_BLOCK_CHANCE_IN = 10;
/** 1-in-N chance garbage shatters into more garbage. `Game.h:213` */
export const GC_GARBAGE_TO_GARBAGE_SHATTER = 2;

// --- Garbage drop timing / sizing ------------------------------------------

/** Mean ticks before dropped garbage falls. `Game.h:216` */
export const GC_AVERAGE_GARBAGE_DROP_DELAY = 300;
/** +/- spread on the garbage drop delay. `Game.h:217` */
export const GC_SPREAD_GARBAGE_DROP_DELAY = 40;
/** Intro pause before play (should be a multiple of 3). `Game.h:220` */
export const GC_START_PAUSE_DELAY = 150;
/** Max height (rows) of a single garbage slab. `Game.h:223` */
export const GC_MAX_GARBAGE_HEIGHT = 11;

// --- Scoring ---------------------------------------------------------------

/** Minimum score awarded for a pattern. `Game.h:226` */
export const GC_MIN_PATTERN_SCORE = 2;
/** Score contribution of a gray block. `Game.h:227` */
export const GC_GRAY_SCORE = 3;
/** Digits in the score display. `Game.h:228` */
export const GC_NUMBER_DIGITS = 7;
/** Minimum digits shown. `Game.h:229` */
export const GC_MIN_NUMBER_DIGITS_DISPLAYED = 4;
/** Max ticks between score-counter increments. `Game.h:230` */
export const GC_MAX_SCORE_INCREMENT_DELAY = 12;
/** Min ticks between score-counter increments. `Game.h:231` */
export const GC_MIN_SCORE_INCREMENT_DELAY = 1;
/** Slope of the score increment delay curve. `Game.h:232` */
export const GC_SCORE_DELAY_SLOPE = 2;
/** Length of the high-score record table. `Game.h:233` */
export const GC_SCORE_REC_LENGTH = 30;
/** Default top score. `Game.h:234` */
export const GC_SCORE_DEFAULT_TOP_SCORE = 600;
/** Length of the multiplier record table. `Game.h:236` */
export const GC_SCORE_MULT_LENGTH = 10;

// --- Initial swapper (cursor) location -------------------------------------

/** Initial swapper X (GC_PLAY_WIDTH / 2 - 1 = 2). `Game.h:244` */
export const GC_INITIAL_SWAPPER_LOCATION_X = Math.trunc(GC_PLAY_WIDTH / 2) - 1;
/** Initial swapper Y. `Game.h:245` */
export const GC_INITIAL_SWAPPER_LOCATION_Y = 4;

// --- X-mode (extreme variant) ----------------------------------------------
// Deferred subsystem, but the constants are simulation-relevant so ported here.

/** `Game.h:248` */
export const GC_INVISIBLE_MAX_ALPHA = 330;
/** `Game.h:249` */
export const GC_INVISIBLE_MIN_ALPHA = -20;
/** `Game.h:250` */
export const GC_INVISIBLE_QUICK_DECAY_RATE = 3;
/** `Game.h:251` */
export const GC_INVISIBLE_PULSE_CHANCE_IN = 30;
/** `Game.h:252` */
export const GC_INVISIBLE_PULSE_STRENGTH = 70;
/** `Game.h:253` */
export const GC_CRAZY_LONG_MODE_PERIOD = 150;
/** `Game.h:254` */
export const GC_CRAZY_SHORT_MODE_PERIOD = 50;
/** `Game.h:255` */
export const GC_MAX_WILD_NUMBER = 3;
/** `Game.h:256` */
export const GC_WILD_PERIOD = 180;
/** `Game.h:257` */
export const GC_WILD_POLYMORPH_PERIOD = 60;
/** `Game.h:258` */
export const GC_MAX_SPECIAL_COLOR_NUMBER = 6;

// --- Block flavors ---------------------------------------------------------
// Special color blocks must be last; wild then gray must directly follow the
// normal flavors. Appearance chances live in BlockManager::newCreepBlock().
// `Game.h:374-391`

export const BF_NORMAL_1 = 0;
export const BF_NORMAL_2 = 1;
export const BF_NORMAL_3 = 2;
export const BF_NORMAL_4 = 3;
export const BF_NORMAL_5 = 4;
export const BF_WILD = 5;
export const BF_GRAY = 6;
export const BF_BLACK = 7;
export const BF_WHITE = 8;
export const BF_SPECIAL_COLOR_1 = 9;
export const BF_SPECIAL_COLOR_2 = 10;
export const BF_SPECIAL_COLOR_3 = 11;
export const BF_SPECIAL_COLOR_4 = 12;
export const BF_SPECIAL_COLOR_5 = 13;
/** Count of normal flavors (5). `Game.h:388` */
export const BF_NUMBER_NORMAL = BF_NORMAL_5 + 1;
/** Total flavor count (14). `Game.h:389` */
export const BF_NUMBER = BF_SPECIAL_COLOR_5 + 1;
/** Count of special flavors. `Game.h:390` */
export const BF_NUMBER_SPECIAL = BF_NUMBER - (BF_GRAY + 1);
/** Last gray/special boundary flavor. `Game.h:391` */
export const BF_FINAL_GRAY_SPECIAL = BF_WHITE;

// --- Per-game state flags (Game::state, GS_*) ------------------------------
// Bit flags for the per-game state machine. `Game.h:343-368`

export const GS_NORMAL = 1 << 0;
export const GS_PAUSED = 1 << 1;
export const GS_UNPAUSED = 1 << 2;
export const GS_SYNC_WAIT = 1 << 3;
export const GS_MAY_HAVE_LOST = 1 << 4;
export const GS_WON = 1 << 5;
export const GS_LOST = 1 << 6;
export const GS_MUST_CONFIRM_LOSS = 1 << 7;
export const GS_CONFIRMATION_HOLD = 1 << 8;
export const GS_END_PLAY = 1 << 9;
export const GS_CONCESSION = 1 << 10;

// --- Random angle table size (used by cosmetic RNG) ------------------------

/** Size of the random angle lookup tables; must be a power of two. `Game.h:137` */
export const GC_SIZE_RANDOM_ANGLE_TABLE = 256;
