import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve cross-package imports to source (not built dist) so tests run without
// a prior `tsc -b`. Currently only the tools/* harness imports @crack-attack/core.
const coreSrc = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@crack-attack/core': coreSrc,
    },
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
