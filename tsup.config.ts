import { defineConfig } from 'tsup';

/**
 * `tsconfig.build.json` y no el raiz: aquel declara `paths` para los tests, y
 * eso hace que tsup inyecte `baseUrl`, deprecado en TypeScript 6.
 */
const tsconfig = 'tsconfig.build.json';

export default defineConfig([
  // API publica: build dual para que la consuman proyectos ESM y CJS por igual.
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    tsconfig,
    clean: true,
    sourcemap: true,
    target: 'node18',
    outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  },
  // El binario solo necesita ESM: lo ejecuta node directamente, nadie lo importa.
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    dts: false,
    tsconfig,
    clean: false,
    sourcemap: true,
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
