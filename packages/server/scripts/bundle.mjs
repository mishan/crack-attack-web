/**
 * bundle.mjs — package the relay as one self-contained ES module,
 * `dist/relay.mjs`, that runs with plain `node` (22.13+). The workspace
 * packages and `ws` are inlined, and records use Node's built-in `node:sqlite`,
 * so nothing needs installing beside it. Bundles the compiled `dist/main.js`,
 * so run it after `tsc -b` (the package's `bundle` script does both).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));

// ws is MIT-licensed; its notice travels with the code we inline.
const require = createRequire(import.meta.url);
const wsLicense = readFileSync(
  join(dirname(require.resolve('ws/package.json')), 'LICENSE'),
  'utf8',
);

await build({
  entryPoints: [join(dist, 'main.js')],
  outfile: join(dist, 'relay.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.13',
  // Unminified: readable stack traces in the server's logs matter more than size.
  minify: false,
  // ws probes for these optional native speed-ups inside try/catch and falls
  // back to plain JS without them; keep them out of the bundle.
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: [
      '// Crack Attack! relay (standalone bundle). GPL-2.0-or-later.',
      '// Includes ws (https://github.com/websockets/ws):',
      ...wsLicense
        .trimEnd()
        .split('\n')
        .map((line) => `//   ${line}`.trimEnd()),
      // ws is CommonJS: inside an ES module its require() calls for Node
      // builtins need a real require function.
      "import { createRequire as __relayCreateRequire } from 'node:module';",
      'const require = __relayCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
