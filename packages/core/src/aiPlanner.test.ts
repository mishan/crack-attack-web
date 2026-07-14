import { describe, expect, it } from 'vitest';
import {
  PLAN_EMPTY,
  PLAN_GARBAGE,
  attackValue,
  evaluateSwap,
  planChainSetup,
  planShatterSetup,
  planUndermine,
  type PlanBoard,
} from './aiPlanner.js';
import { AiController } from './aiController.js';
import { GameSim } from './gameSim.js';
import { readPlanBoard } from './aiPlanner.js';

/**
 * Build a PlanBoard from ASCII rows given top-to-bottom. `.` = empty, `#` =
 * garbage, a digit = that flavour. Column-major storage, y=0 at the bottom.
 */
function board(rows: string[]): PlanBoard {
  const height = rows.length;
  const width = rows[0]!.length;
  const cell = new Int16Array(width * height);
  for (let r = 0; r < height; r++) {
    const y = height - 1 - r; // top row is the highest y
    for (let x = 0; x < width; x++) {
      const ch = rows[r]![x]!;
      cell[x * height + y] = ch === '.' ? PLAN_EMPTY : ch === '#' ? PLAN_GARBAGE : Number(ch);
    }
  }
  return { cell, width, height };
}

describe('aiPlanner cascade evaluator', () => {
  it('a swap that completes a 3-run clears exactly those blocks (no chain)', () => {
    // Row0 = 1 1 2 1; swapping the 2 and the last 1 makes 1 1 1 …
    const b = board(['....', '1121']);
    const c = evaluateSwap(b, 2, 0);
    expect(c.chainDepth).toBe(1);
    expect(c.totalCleared).toBe(3);
    expect(c.maxRound).toBe(3);
    expect(c.garbageShattered).toBe(0);
  });

  it('gravity forms a 4-wide combo (magnitude drives width garbage)', () => {
    // A floating 1 over a gap drops to complete a 4-in-a-row.
    const b = board(['...1', '111.']);
    const c = evaluateSwap(b, 0, 1); // harmless empty swap; gravity does the work
    expect(c.chainDepth).toBe(1);
    expect(c.totalCleared).toBe(4);
    expect(c.maxRound).toBe(4);
  });

  it('detects a 2-chain: a vertical clear drops a cap into a horizontal match', () => {
    // Swapping the Y/2 at (1,2) with the 1 at (2,2) makes column 1 a vertical
    // 1-1-1 (round 1). Clearing it drops the 3 on top of column 1 to the floor,
    // where it lands next to the 3s in columns 0 and 2 → horizontal match (round 2).
    const b = board([
      '.3.', // y3:  .  G  .
      '.21', // y2:  .  Y  1
      '.11', // y1:  .  1  1
      '313', // y0:  G  1  G
    ]);
    const c = evaluateSwap(b, 1, 2);
    expect(c.chainDepth).toBe(2);
    expect(c.totalCleared).toBe(6);
  });

  it('shatters garbage adjacent to a match', () => {
    const b = board([
      '####', // garbage row
      '1121', // swap makes 1 1 1 under the garbage
    ]);
    const c = evaluateSwap(b, 2, 0);
    expect(c.chainDepth).toBe(1);
    expect(c.garbageShattered).toBe(3); // the 3 garbage cells above the cleared run
  });

  it('a swap that completes nothing returns an all-zero cascade', () => {
    const b = board(['....', '1213']);
    const c = evaluateSwap(b, 0, 0);
    expect(c).toEqual({ chainDepth: 0, totalCleared: 0, maxRound: 0, garbageShattered: 0 });
  });

  it('attackValue ranks a chain far above a same-size single combo', () => {
    const chain = attackValue({ chainDepth: 3, totalCleared: 9, maxRound: 3, garbageShattered: 0 });
    const flat = attackValue({ chainDepth: 1, totalCleared: 9, maxRound: 9, garbageShattered: 0 });
    expect(chain).toBeGreaterThan(flat);
  });
});

/** Apply a lateral swap `(x,y)`↔`(x+1,y)` in place (test helper). */
function applySwap(b: PlanBoard, x: number, y: number): void {
  const tmp = b.cell[x * b.height + y]!;
  b.cell[x * b.height + y] = b.cell[(x + 1) * b.height + y]!;
  b.cell[(x + 1) * b.height + y] = tmp;
}

describe('planShatterSetup', () => {
  it('finds the cheapest lateral plan to a window under a slab', () => {
    // 1s at x 0,2,4 under a full-width slab: the best window is {1,2,3}
    // (cost 2 — shuttle the outer 1s inward one cell each). The first move is
    // the rightmost source that must move right: the 1 at x0 → swap at (0,0).
    const b = board(['######', '121213']);
    expect(planShatterSetup(b, 10)).toEqual({ x: 0, y: 0, cost: 2 });
  });

  it('respects the cost cap and returns null without garbage', () => {
    expect(planShatterSetup(board(['######', '121213']), 1)).toBeNull();
    expect(planShatterSetup(board(['......', '121213']), 10)).toBeNull();
  });

  it('sees windows beside a slab, not just under one', () => {
    // Garbage occupies (0,0); the only garbage-adjacent window is {1,2,3}.
    // 1s at x 1,2,4 → one swap lines up 1 1 1 beside the slab.
    const b = board(['......', '#11211']);
    expect(planShatterSetup(b, 10)).toEqual({ x: 3, y: 0, cost: 1 });
    // And that final swap really does shatter.
    expect(evaluateSwap(b, 3, 0).garbageShattered).toBe(1);
  });

  it('sources cannot cross garbage in the row, and standing matches are skipped', () => {
    // Row 1: the slab cell splits the row, so neither side has 3 of a colour.
    // Row 0: a standing 3+ match (only constructible in a test — the sim would
    // already be clearing it) must not be "planned", even at cost 1 by sliding
    // a fourth matching block around. Nothing plannable ⇒ null.
    const b = board(['......', '11#212', '333333']);
    expect(planShatterSetup(b, 10)).toBeNull();
  });

  it('executing the plan converges: cost strictly decreases to a shattering swap', () => {
    const b = board(['######', '121213']);
    let plan = planShatterSetup(b, 10);
    let lastCost = Infinity;
    let guard = 0;
    while (plan && plan.cost > 1) {
      expect(plan.cost).toBeLessThan(lastCost);
      lastCost = plan.cost;
      applySwap(b, plan.x, plan.y);
      plan = planShatterSetup(b, 10);
      expect(++guard).toBeLessThan(10);
    }
    expect(plan).not.toBeNull();
    // The remaining single swap is exactly what the fire branch would execute.
    const cascade = evaluateSwap(b, plan!.x, plan!.y);
    expect(cascade.garbageShattered).toBeGreaterThan(0);
  });

  it('never proposes swapping two matching blocks (progress is guaranteed)', () => {
    // Four 1s available; the minimal subset must exclude the one whose move
    // would swap 1↔1. Whatever plan comes back, its swap must change the board.
    const b = board(['######', '112131']);
    const plan = planShatterSetup(b, 10);
    expect(plan).not.toBeNull();
    const before = b.cell.slice();
    applySwap(b, plan!.x, plan!.y);
    expect(b.cell).not.toEqual(before);
  });
});

describe('planShatterSetup vertical windows', () => {
  it('assembles a colour column beside a slab, one row at a time', () => {
    // A 3-tall slab in column 0. Column 1 is the only garbage-adjacent window;
    // flavour 2 is one lateral swap away (row y2 must bring its 2 from x2).
    const b = board(['#27.', '#72.', '#27.', '4545']);
    expect(planShatterSetup(b, 10)).toEqual({ x: 1, y: 2, cost: 1 });
    expect(evaluateSwap(b, 1, 2).garbageShattered).toBeGreaterThan(0);
  });

  it('vertical plans converge over multiple rows', () => {
    // Flavour 2 is the only colour present in all three garbage-adjacent rows;
    // it needs a lateral move in two of them to line up in column 1.
    const b = board(['#62.', '#62.', '#25.', '4545']);
    let plan = planShatterSetup(b, 10);
    expect(plan).toEqual({ x: 1, y: 2, cost: 2 });
    applySwap(b, plan!.x, plan!.y);
    plan = planShatterSetup(b, 10);
    expect(plan?.cost).toBe(1);
    expect(evaluateSwap(b, plan!.x, plan!.y).garbageShattered).toBeGreaterThan(0);
  });

  it('a 1-wide support tower offers no vertical plan (no lateral supply)', () => {
    // Slab perched on a lone column: every row's segment is a single cell, so
    // no colour can be brought in laterally — the undermine fallback's job.
    const b = board(['.#..', '.1..', '.2..', '.3..', '4256']);
    expect(planShatterSetup(b, 10)).toBeNull();
  });
});

describe('planChainSetup', () => {
  const opts = { minChain: 2, minRun: 4, shatterWeight: 3 };

  it('finds the setup swap that re-enables a broken 2-chain', () => {
    // The proven 2-chain board (see the cascade test above) with its bottom
    // row broken: '313' → '133'. No swap fires anything now, but swapping
    // (0,0)↔(1,0) restores '313', after which the (1,2) trigger swap cascades
    // to depth 2. The planner must find that setup and price the payoff.
    const b = board([
      '.3.', // the cap that falls into the round-2 match
      '.21',
      '.11',
      '133', // broken: the setup swap restores '313'
    ]);
    const plan = planChainSetup(b, opts);
    expect(plan).not.toBeNull();
    expect({ x: plan!.x, y: plan!.y }).toEqual({ x: 0, y: 0 });
    // Payoff of the enabled cascade: depth 2, 6 cleared → 1·width + 3.
    expect(plan!.score).toBe(
      attackValue({ chainDepth: 2, totalCleared: 6, maxRound: 3, garbageShattered: 0 }),
    );
    // And the enabled trigger really is a fire: apply the setup and check.
    applySwap(b, 0, 0);
    expect(evaluateSwap(b, 1, 2).chainDepth).toBe(2);
  });

  it('returns null when no colour can ever form a run', () => {
    expect(planChainSetup(board(['....', '1213']), opts)).toBeNull();
  });

  it('lookahead finds a two-setup construction and the ladder converges to a fire', () => {
    // A 2-chain pattern using colour 5 — deliberately scarce (exactly three
    // 5s on the board) with a neutral 6 blocking column 2, so only one chain
    // shape exists and the trigger swap can't double as a repair move. Broken
    // in two independent places: the cap pushed off column 1 ('.54.' →
    // '.45.') and a floor 5 pushed off column 2 ('5152' → '5125'). No single
    // swap fires, no single setup enables a fire — but two setups do. The
    // 2-level plan must appear only with lookahead, and executing the ladder
    // must converge to a real chain trigger.
    const rows = ['.45.', '.21.', '.16.', '5125'];
    expect(planChainSetup(board(rows), opts)).toBeNull();
    const b = board(rows);
    let plan = planChainSetup(b, { ...opts, lookahead: true });
    expect(plan).not.toBeNull();

    // Execute up the ladder: at most two setups, then a firing trigger exists.
    for (let step = 0; step < 2 && plan; step++) {
      applySwap(b, plan.x, plan.y);
      plan = planChainSetup(b, { ...opts, lookahead: true });
    }
    // After the construction, some swap cascades to a 2-chain.
    let fires = false;
    for (let y = 0; y < b.height && !fires; y++) {
      for (let x = 0; x < b.width - 1 && !fires; x++) {
        if (evaluateSwap(b, x, y).chainDepth >= 2) fires = true;
      }
    }
    expect(fires).toBe(true);
  });

  it('never proposes a setup swap that itself clears', () => {
    // The only interesting swap here completes 1-1-1 immediately: that is a
    // clear (the fire/survival branches own it), not a setup — and the mere
    // 3-clear it enables is below the fire thresholds anyway.
    expect(planChainSetup(board(['....', '1121']), opts)).toBeNull();
  });
});

describe('planUndermine', () => {
  it('digs the load-bearing block under a slab into the neighbouring gap', () => {
    // Tower at column 1 carries the slab; the top tower block (1,y2) can dig
    // left (swap at x0) or right (swap at x1). Nearest to the cursor wins.
    const b = board(['.#..', '.1..', '.2..', '3123']);
    expect(planUndermine(b, 0, 2)).toEqual({ x: 0, y: 2 });
    expect(planUndermine(b, 3, 2)).toEqual({ x: 1, y: 2 });
  });

  it('ignores digs that carry no garbage, and blocks that cannot fall', () => {
    // Same shape, no slab: nothing is load-bearing — undermining is not
    // generic flattening. And with a slab but no fall-through cell, null too.
    expect(planUndermine(board(['....', '.1..', '.2..', '3123']), 0, 0)).toBeNull();
    expect(planUndermine(board(['.#..', '31.4', '324.', '3123']), 0, 0)).toBeNull();
  });
});

describe('aiPlanner on real sims', () => {
  it('readPlanBoard reflects the sim grid dimensions and finds blocks', () => {
    const sim = new GameSim(42);
    for (let t = 0; t < 200; t++) sim.step(new AiController('easy').decide(sim));
    const b = readPlanBoard(sim.grid);
    expect(b.width).toBe(6);
    expect(b.height).toBeGreaterThan(0);
    // The opening board is full of blocks, so some cells are non-empty.
    let blocks = 0;
    for (const v of b.cell) if (v >= 0) blocks++;
    expect(blocks).toBeGreaterThan(0);
  });

  it('the evaluator finds real chain opportunities during play', () => {
    // Over a played-out game there should exist board states where some swap
    // triggers a 2+ chain — proof the engine detects chains in real positions.
    let bestChain = 0;
    for (const seed of [1, 7, 42, 2026]) {
      const sim = new GameSim(seed);
      const ai = new AiController('medium');
      for (let t = 0; t < 3000 && !sim.lost; t++) {
        sim.step(ai.decide(sim));
        if (t % 25 === 0) {
          const b = readPlanBoard(sim.grid);
          for (let y = 0; y < b.height; y++) {
            for (let x = 0; x < b.width - 1; x++) {
              const c = evaluateSwap(b, x, y);
              if (c.chainDepth > bestChain) bestChain = c.chainDepth;
            }
          }
        }
      }
    }
    expect(bestChain).toBeGreaterThanOrEqual(2);
  });
});
