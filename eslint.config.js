// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'crack-attack/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // The deterministic simulation and wire protocol must stay platform-agnostic:
  // no DOM, no Node builtins. This guard is load-bearing for cross-runtime determinism.
  {
    files: ['packages/core/src/**/*.ts', 'packages/protocol/src/**/*.ts'],
    languageOptions: {
      globals: {},
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'os', 'crypto', 'three', 'ws'],
              message: 'core/protocol must not import DOM or Node/platform modules.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'core/protocol must be platform-agnostic.' },
        { name: 'document', message: 'core/protocol must be platform-agnostic.' },
        { name: 'process', message: 'core/protocol must be platform-agnostic.' },
        { name: 'Buffer', message: 'core/protocol must be platform-agnostic.' },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
    },
  },
  // The client is a browser app: DOM/WebGL globals are expected. TypeScript's
  // DOM lib already checks these, so `no-undef` (which doesn't know the DOM) is
  // redundant here and would false-positive on `window`, `requestAnimationFrame`,
  // `KeyboardEvent`, etc.
  {
    files: ['packages/client/src/**/*.ts'],
    rules: {
      'no-undef': 'off',
    },
  },
);
