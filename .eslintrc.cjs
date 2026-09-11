/**
 * ESLint configuration.
 *
 * The rule set is deliberately small. TypeScript already runs in `strict` mode
 * in both workspaces, so the compiler - not the linter - is what catches type
 * mistakes; the rules kept here are the ones tsc does not cover.
 */
module.exports = {
  root: true,
  env: { browser: true, node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],

  rules: {
    // The two that actually prevent bugs in this codebase: a conditionally
    // called hook corrupts React's hook order, and a stale dependency array is
    // how a filter change silently stops refetching.
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',

    /*
     * Explicit `any` is allowed; implicit `any` is not.
     *
     * `noImplicitAny` (via strict) catches the accidental case, which is the
     * one that actually loses type safety by surprise. The explicit `any`s
     * that remain are all at boundaries where a truthful type is not
     * available: pg's own `values: any[]` signature, Stripe fields that moved
     * between API versions, raw database rows before they are shaped, and the
     * Express 4/5 `req.query` getter difference. Each is commented at the
     * site. Banning the keyword there would mean inventing a type that claims
     * more than we know, which is worse than admitting the gap.
     */
    '@typescript-eslint/no-explicit-any': 'off',

    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
    ],

    // An empty catch is a deliberate "this failure is not worth reporting",
    // used for clipboard writes and telemetry. Any other empty block is a bug.
    'no-empty': ['error', { allowEmptyCatch: true }],

    // Logging goes through pino so it is structured and level-filtered;
    // console.log bypasses that and is invisible in production.
    'no-console': ['error', { allow: ['warn', 'error'] }],

    eqeqeq: ['error', 'smart'],
    'prefer-const': 'error',
    'no-var': 'error',
  },

  overrides: [
    {
      // Operational scripts are run by hand and report progress on stdout;
      // that output is their interface, not stray debugging.
      files: ['server/src/scripts/**', 'server/src/eval/**', 'server/src/db/**'],
      rules: { 'no-console': 'off' },
    },
  ],

  ignorePatterns: [
    'node_modules',
    'dist',
    'web/dist',
    'server/dist',
    // Superseded Python prototype, kept for provenance.
    'legacy',
    '*.config.js',
    '*.config.ts',
    '*.cjs',
    '*.mjs',
  ],
};
