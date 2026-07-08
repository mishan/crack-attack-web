import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Co-located *.test.ts files across all workspace packages.
    include: ['packages/*/src/**/*.test.ts', 'tools/*/src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
