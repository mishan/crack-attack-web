#!/usr/bin/env node
// Takes the README's screenshots from the built game; see README.md.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { frames, gif, pageErrors, serve, steady } from 'shotbox';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const web = path.join(root, 'packages/client/dist/web');
const relayMain = path.join(root, 'packages/server/dist/main.js');
const out = path.join(root, 'docs/images');
const only = process.argv.slice(2);

for (const built of [web, relayMain]) {
  if (!existsSync(built)) {
    console.error(
      `${path.relative(root, built)} is missing: run pnpm build and the client build first`,
    );
    process.exit(1);
  }
}

await mkdir(out, { recursive: true });
const scratch = await mkdtemp(path.join(os.tmpdir(), 'shots-'));
const server = await serve(web);
const page0 = `http://127.0.0.1:${server.address().port}/`;
const relay = await startRelay();
// SwiftShader: WebGL in software, the same on every machine.
const browser = await chromium.launch({
  args: [...steady, '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const failures = [];
const at = (query) => `${page0}?${query ? `${query}&` : ''}relay=${relay.url}`;

const shots = {
  // 0:45 to 0:54 of the demo: chains of x4 and x6 on the left, x2 and x3 on the right.
  async demo() {
    const { page, rec } = await steadyPage('demo', { width: 960, height: 540 }, 15);
    await page.goto(at('demo=hard,hard'));
    await rec.run(49000);
    rec.start();
    await rec.hold(9000);
    await gif((await rec.end()).dir, path.join(out, 'demo.gif'), { fps: 15, width: 720 });
    console.log('demo.gif');
    await page.close();
  },

  async title() {
    const { page, rec } = await steadyPage('title');
    await page.goto(at(''));
    await rec.run(1000);
    await save(page, 'title.png');
    await page.close();
  },

  async phone() {
    const { page, rec } = await steadyPage('phone', { width: 390, height: 844 }, 10, {
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    // A practice run: a ranked one's seed comes from the relay, a new board each time.
    await page.addInitScript(() => localStorage.setItem('crack-attack.ranked', 'off'));
    await page.goto(at('solo'));
    await rec.run(20000);
    await save(page, 'phone.png');
    await page.close();
  },

  // A lobby with a match on (two idle players and a watcher), a room waiting, and a vs-AI game.
  async lobby() {
    const alice = await player('alice');
    await alice.click('#net-create');
    const code = await roomCode(alice);
    const bob = await player('bob');
    await bob.fill('#net-code', code);
    await bob.click('#net-join');
    await bob.locator('#net-ready').click();
    await alice.locator('#net-ready').click();
    const carol = await player('carol');
    await carol.getByRole('button', { name: 'watch' }).click();
    const dave = await player('dave');
    await dave.click('#net-create');
    const erin = await player('erin');
    await erin.click('#net-create-ai');
    await erin.getByRole('button', { name: /hard/i }).click();
    await erin.locator('#net-ready').click();

    const you = await player('you');
    await you.waitForFunction(() => document.querySelectorAll('#net-rooms > div').length === 3);
    await you.waitForTimeout(500);
    const panel = you.locator('#net-rooms').locator('xpath=..');
    await panel.screenshot({ path: path.join(out, 'lobby.png') });
    console.log('lobby.png');
    for (const p of [alice, bob, carol, dave, erin, you]) await p.context().close();
  },
};

try {
  for (const [name, shot] of Object.entries(shots)) {
    if (only.length && !only.includes(name)) continue;
    await shot();
  }
} finally {
  await browser.close();
  server.close();
  relay.process.kill();
  await rm(scratch, { recursive: true, force: true });
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

// A page whose time, requestAnimationFrame and Math.random only move when the script says,
// so the game (whose seeds come from Math.random) plays the same match every run.
async function steadyPage(name, viewport = { width: 1280, height: 720 }, fps = 10, options = {}) {
  const page = await browser.newPage({ viewport, ...options });
  watchErrors(page, name);
  const rec = await frames(page, { dir: path.join(scratch, name), fps });
  return { page, rec };
}

async function player(name) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
  });
  await context.addInitScript((n) => localStorage.setItem('crack-attack.name', n), name);
  const page = await context.newPage();
  watchErrors(page, name);
  await page.goto(at('net'));
  await page.waitForSelector('#net-status:has-text("connected")');
  return page;
}

async function roomCode(page) {
  const status = page.locator('#net-status');
  await status.filter({ hasText: /^room / }).waitFor();
  return (await status.textContent()).match(/^room (\w{5})/)[1];
}

function watchErrors(page, name) {
  const errors = pageErrors(page);
  page.on('close', () => {
    for (const e of errors) failures.push(`${name}: ${e}`);
  });
}

async function save(page, file) {
  await page.screenshot({ path: path.join(out, file) });
  console.log(file);
}

function startRelay() {
  const child = spawn(process.execPath, [relayMain], {
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      DB: ':memory:',
      CORS_ORIGIN: page0.slice(0, -1),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`relay exited (${code})`)));
    child.stdout.on('data', (chunk) => {
      const port = String(chunk).match(/listening on :(\d+)/)?.[1];
      if (port) resolve({ process: child, url: `ws://127.0.0.1:${port}` });
    });
  });
}
