import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'dev-dist/', 'public/'] },
  js.configs.recommended,
  { files: ['scripts/**/*.mjs', 'vite.config.ts'], languageOptions: { globals: globals.node } },
  { files: ['src/**/*.ts'], languageOptions: { globals: globals.browser } },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
