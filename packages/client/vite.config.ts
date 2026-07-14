import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Resolve the workspace packages to their TypeScript source so `vite dev`/`build`
// don't require a prior `tsc -b`, and — critically — never pick up a *stale*
// built `dist` (e.g. an old PROTOCOL_VERSION or codec that silently drops new
// message fields). Vite compiles the source inline.
const coreSrc = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));
const protocolSrc = fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url));

export default defineConfig({
  // The package directory is the Vite root (index.html lives here).
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Relative asset paths so the built bundle works when served from any
  // subdirectory (e.g. a sub-path deploy), not just the domain root. Note: the
  // app must still be *served over HTTP* — opening dist/web/index.html directly
  // via file:// won't load ES modules. Use `pnpm --filter @crack-attack/client
  // dev`, or `… preview` after a build.
  base: './',
  resolve: {
    alias: {
      '@crack-attack/core': coreSrc,
      '@crack-attack/protocol': protocolSrc,
    },
  },
  build: {
    // Keep the bundle under the already-gitignored dist/ (tsc emits type stubs
    // to dist/*, Vite emits the web bundle to dist/web/*; no collision).
    outDir: 'dist/web',
    emptyOutDir: true,
  },
});
