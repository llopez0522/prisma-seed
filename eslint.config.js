import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      '.fixtures/**',
      '.sandbox/**',
      'node_modules/**',
      'coverage/**',
      // Fuera del tsconfig raiz: se comprueban con tests/types/run.sh.
      'tests/types/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // El CLI escribe en stdout por diseno; el logger centraliza la salida.
      'no-console': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Este propio archivo es .js y queda fuera del tsconfig, asi que el servicio
    // de proyecto no puede tiparlo. Se lintea sin reglas con informacion de tipos.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  }
);
