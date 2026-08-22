import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Los fixtures y el test de ZenStack importan el paquete por su NOMBRE, que
    // es como lo hace un consumidor: en el proyecto externo resuelve por
    // node_modules, y aqui a la fuente. Igual que el `paths` del tsconfig.
    alias: {
      'prisma-seed': path.resolve(import.meta.dirname, 'src/index.ts'),
    },
  },
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          // Las pruebas de integracion tocan bases reales (ver docker-compose.yml)
          // y comparten esquema, asi que no pueden solaparse.
          //
          // En Vitest 4 esto es toda la configuracion necesaria: `poolOptions`
          // ya no existe a nivel de proyecto, y `fileParallelism: false` fuerza
          // por si solo `maxWorkers` a 1. En la 3 se escribia
          // `poolOptions.threads.singleThread`.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
  },
});
