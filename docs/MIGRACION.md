# Migración desde `prisma-seeder-custom`

`prisma-seed` es un paquete distinto, no una actualización. El cambio son dos
comandos y, en la mayoría de los casos, nada más.

```bash
npm uninstall prisma-seeder-custom
npm install --save-dev prisma-seed
```

El binario pasa a llamarse `prisma-seed`. Actualiza los scripts de tu
`package.json` y cualquier pipeline que lo invoque.

## 1. Tus seeders siguen funcionando

Un módulo con `main()` y `down()` sigue siendo válido, cree o no su propio
cliente. No hay que reescribirlos para actualizar.

Dicho eso, esto es lo que conviene cambiar cuando toques cada uno:

```js
// Antes: cada seeder abría su propio pool y ninguno lo cerraba.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() { … }
```

```js
// Ahora: el cliente llega inyectado, uno solo para todo el proceso.
async function main({ prisma, logger }) { … }
```

## 2. `rollback` cambió de significado

Es el cambio de mayor impacto. **Revisa cualquier script o pipeline que lo use.**

| | `prisma-seeder-custom` | `prisma-seed` |
|---|---|---|
| `rollback` | revertía **todo** el histórico | revierte solo el **último lote** |
| equivalente al de antes | — | `rollback --all` |

Es la semántica de `migrate:rollback` de Laravel. Si tenías `rollback` en un
script esperando que lo borrara todo, cámbialo a `rollback --all`.

## 3. La tabla `SeedExecution` se migra sola

Gana una columna `batch`. La primera vez que ejecutes cualquier comando se
detecta y se añade con `ALTER TABLE … ADD COLUMN batch INTEGER NOT NULL DEFAULT 1`;
todo tu histórico queda en el lote 1. No hay que hacer nada.

Si la tienes declarada en tu `schema.prisma` siguiendo el README de `prisma-seeder-custom`,
añádele el campo para que las migraciones no vean deriva:

```prisma
model SeedExecution {
  id         Int      @id @default(autoincrement())
  seedName   String   @unique
  batch      Int      @default(1)      // nuevo
  executedAt DateTime @default(now())
}
```

## 4. Si importabas el paquete

Cambia el nombre en los imports. `main` desaparece en favor del mapa `exports`,
lo que solo te afecta si hacías `require('prisma-seeder-custom/cli.js')`, que
nunca fue una API pública.

Lo que sí es nuevo y probablemente quieras:

```ts
import { runSeeders } from 'prisma-seed';

const prisma = new PrismaClient();
await runSeeders(prisma);
await prisma.$disconnect();
```

## 5. Lo que ya no hace falta que sufras

- **MySQL y SQLite funcionan.** Antes el SQL era exclusivo de PostgreSQL:
  MySQL fallaba entero y SQLite dejaba la clave primaria a `NULL` sin avisar.
- **`generate` no abre conexión** ni exige `@prisma/client`.
- **El seeder y su registro son atómicos**: un fallo a mitad ya no provoca que se
  repita en la siguiente ejecución.
- **`run` arranca en un proyecto sin la tabla.** Antes abortaba con un
  `TypeError` por el interop de `inquirer`.
