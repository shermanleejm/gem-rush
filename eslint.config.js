import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
    },
  },
  {
    // The host is a CLI: its console output is the product, not debug noise.
    // Node globals are declared explicitly because the shared package
    // deliberately has none, so they cannot be enabled repo-wide.
    files: ['packages/server/**'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', setTimeout: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },
  {
    // Enforce the headless rule from the brief mechanically. The tsconfig
    // already omits the DOM lib; this makes the intent explicit and catches a
    // stray global before the type error is puzzled over.
    files: ['packages/shared/**'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'shared/ must run headless — no DOM.' },
        { name: 'window', message: 'shared/ must run headless — no DOM.' },
        { name: 'process', message: 'shared/ must run headless — no Node APIs.' },
      ],
    },
  },
);
