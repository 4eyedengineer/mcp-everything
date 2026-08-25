module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  // test/**: e2e specs run under test/jest-e2e.json.
  // *.spec.ts / *.test.ts / __tests__/**: unit test files. Both groups are
  // excluded from tsconfig.json's "include", so typed linting (which needs
  // parserOptions.project) can't parse them here.
  ignorePatterns: [
    '.eslintrc.js',
    'test/**',
    '**/*.spec.ts',
    '**/*.test.ts',
    '**/__tests__/**',
  ],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'prettier/prettier': ['error', { endOfLine: 'auto' }],
  },
};