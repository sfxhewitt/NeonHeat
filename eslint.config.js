import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const browserGlobals = Object.keys(globals.browser).filter((g) => !(g in globals.es2021));

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    // Architecture rule 1: the simulation is pure, deterministic TypeScript.
    files: ['packages/sim/**/*.ts', 'packages/missions/**/*.ts'],
    languageOptions: { globals: { ...globals.es2021 } },
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['three', 'three/*'], message: 'sim/missions must not import Three.js' }] },
      ],
      'no-restricted-globals': ['error', ...browserGlobals.map((name) => ({ name, message: 'No browser APIs in the simulation' }))],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded Rng' },
        { object: 'Date', property: 'now', message: 'Use world time' },
      ],
    },
  },
);
