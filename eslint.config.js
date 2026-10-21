// @ts-check
import eslint from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      // scripts/bundle-server.mjs output (gitignored; a local build must not fail lint).
      'dist-bundle/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'config-schema/**',
      '**/*.cjs',
      // Generated typesafe-i18n files carry a global eslint-disable (unused-disable warnings).
      '**/i18n/i18n-util*.ts',
      '**/i18n/i18n-svelte.ts',
      '**/.svelte-kit/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
    rules: {
      // Svelte/TS knows browser globals from lib.dom; core no-undef cannot read those types inside component scripts.
      'no-undef': 'off',
      'svelte/no-navigation-without-resolve': 'off',
      // Local scratch collections do not need SvelteMap/SvelteSet.
      'svelte/prefer-svelte-reactivity': 'off',
    },
  },
  {
    files: ['**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parser: tseslint.parser,
    },
  },
  {
    rules: {
      'max-lines': ['warn', { max: 1500, skipBlankLines: true, skipComments: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // .mjs scripts have no TS lib, so node globals must be declared for no-undef.
    files: ['**/scripts/**', '**/test/**', '**/*.test.ts'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
