import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    // Plain Node scripts that exercise the built package.
    files: ['smoke/**'],
    languageOptions: {
      globals: { require: 'readonly', console: 'readonly', process: 'readonly' }
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  }
);
