import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve cross-package imports to source (not built dist) so `pnpm test` works
// without a prior `tsc -b`. The client/tool tests import @crack-attack/core,
// whose package entry points at dist/index.js — absent in a fresh checkout.
const coreSrc = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));
const protocolSrc = fileURLToPath(new URL('./packages/protocol/src/index.ts', import.meta.url));
const serverSrc = fileURLToPath(new URL('./packages/server/src/index.ts', import.meta.url));
// tools/load-test imports client modules by their built path (the client is an
// app with no package entry): map `…/dist/x.js` back to `src/x.ts`.
const clientSrcDir = fileURLToPath(new URL('./packages/client/src/', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: '@crack-attack/core', replacement: coreSrc },
      { find: '@crack-attack/protocol', replacement: protocolSrc },
      { find: '@crack-attack/server', replacement: serverSrc },
      { find: /^@crack-attack\/client\/dist\/(.*)\.js$/, replacement: `${clientSrcDir}$1.ts` },
    ],
  },
  test: {
    // Co-located *.test.ts files across all workspace packages.
    include: ['packages/*/src/**/*.test.ts', 'tools/*/src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'tools/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
