import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'node_modules/**', '.vscode-test/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Promise の放置や誤った await は拡張機能のエラー表示漏れにつながるため、重点的に検査する
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error'
    }
  },
  {
    // node:test の test() はトップレベルで呼ぶ前提で、戻り値の Promise はランナーが待つ
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' }
  },
  {
    files: ['**/*.cjs', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly', process: 'readonly', console: 'readonly' }
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  }
);
