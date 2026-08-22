import { defineConfig } from 'vitest/config';

/**
 * Configuracion para ejecutar el test del cliente real DENTRO del proyecto
 * consumidor.
 *
 * Se usa el vitest del propio proyecto, no el de esta libreria: es lo unico que
 * resuelve sus `node_modules` y sus alias. La libreria se copia a
 * `node_modules/`, asi que el test la importa por su nombre igual que haria
 * cualquier consumidor.
 */

const projectDir = process.env['SEED_REAL_PROJECT_DIR'] ?? process.cwd();

export default defineConfig({
  resolve: {
    // El alias `@/*` que suelen declarar los proyectos en su tsconfig. Sin esto,
    // el modulo del cliente no puede importar lo que tenga detras.
    alias: { '@': projectDir },
  },
  test: {
    environment: 'node',
    include: ['.psc-integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
