#!/usr/bin/env node
// Audits each screen of the built game with `shotbox a11y`; see README.md.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { accessible, serve } from 'shotbox';
import { relayMain, root, startRelay, web } from './relay.mjs';

const out = path.join(root, 'tools/screenshots/a11y-report');
const only = process.argv.slice(2);

for (const built of [web, relayMain]) {
  if (!existsSync(built)) {
    console.error(
      `${path.relative(root, built)} is missing: run pnpm build and the client build first`,
    );
    process.exit(1);
  }
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const server = await serve(web);
const page0 = `http://127.0.0.1:${server.address().port}/`;
const relay = await startRelay(page0.slice(0, -1));
// Headed, so the page is on the accessibility bus; one window the size of the screen.
const browser = await chromium.launch({
  ...accessible,
  args: [
    ...accessible.args,
    '--window-size=1280,800',
    '--window-position=0,0',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const page = await (await browser.newContext({ viewport: null })).newPage();
const at = (query) => `${page0}?${query ? `${query}&` : ''}relay=${relay.url}`;
const summary = [];
let problems = 0;

async function go(query) {
  await page.goto(at(query));
  await page.waitForTimeout(2500);
}

const screens = {
  async attract() {
    await go('');
    // The title card takes no focus: any key starts play.
    await audit('attract', { tabwalk: false });
  },
  async solo() {
    await go('solo');
    await audit('solo');
    await page.getByRole('button', { name: 'Play vs AI' }).click();
    await audit('ai-picker');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Watch AI vs AI' }).click();
    await audit('matchup-picker');
  },
  // Waits for the untouched solo game to top out, a minute or two.
  async gameover() {
    await go('solo');
    await page.getByRole('button', { name: 'Submit', exact: true }).waitFor({ timeout: 300000 });
    await audit('name-prompt');
    await page.getByRole('button', { name: "Don't submit" }).click();
    await audit('gameover');
    await page.getByRole('button', { name: 'Share score' }).click();
    await audit('share');
  },
  async lobby() {
    await go('net');
    await audit('lobby');
  },
  async account() {
    await go('account');
    await audit('account');
  },
  async scores() {
    await go('scores');
    await audit('scores');
  },
  async ladder() {
    await go('ladder');
    await audit('ladder');
  },
};

try {
  for (const [name, screen] of Object.entries(screens)) {
    if (only.length && !only.includes(name)) continue;
    await screen();
  }
} finally {
  await browser.close();
  server.close();
  relay.process.kill();
}
await writeFile(path.join(out, 'summary.txt'), summary.join('\n') + '\n');
console.log(summary.join('\n'));
console.log(`reports in ${path.relative(root, out)}/`);
process.exit(problems ? 1 : 0);

async function audit(name, { tabwalk = true } = {}) {
  await page.bringToFront();
  await page.waitForTimeout(800);
  const window = ['--window', 'Crack Attack!.*'];
  await shotbox(`${name}.tree.txt`, ['a11y', 'tree', ...window]);
  const lint = JSON.parse(
    await shotbox(`${name}.lint.json`, ['a11y', 'lint', '--json', ...window]),
  );
  const contrast = JSON.parse(
    await shotbox(`${name}.contrast.json`, ['a11y', 'contrast', '--json', ...window]),
  );
  const walk = tabwalk
    ? JSON.parse(
        await shotbox(`${name}.tabwalk.json`, [
          'a11y',
          'tabwalk',
          '--json',
          '--visible',
          '--max',
          '40',
          ...window,
        ]),
      )
    : { focus: [] };
  await page.screenshot({ path: path.join(out, `${name}.png`) });

  const unnamed = lint.length;
  const unfocused = walk.focus.filter((stop) => stop.changed < stop.needed).length;
  // Contrast is reported, not failed: it also measures text dimmed behind an
  // open dialog and the blinking attract prompt mid-fade.
  const lowContrast = contrast.problems.length;
  problems += unnamed + unfocused;
  summary.push(
    `${name.padEnd(15)} lint ${unnamed}  focus not shown ${unfocused}  low contrast ${lowContrast}`,
  );
}

async function shotbox(file, args) {
  let text;
  try {
    text = execFileSync('shotbox', args, { encoding: 'utf8', timeout: 180000 });
  } catch (e) {
    // They exit 1 when they find something; the findings are still on stdout.
    if (e.stdout === undefined) throw e;
    text = e.stdout;
  }
  await writeFile(path.join(out, file), text);
  return text;
}
