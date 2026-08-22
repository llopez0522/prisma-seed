# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).
Versionado según [SemVer](https://semver.org/lang/es/).

## [1.0.0] — 2026-08-22

Primera versión de `prisma-seed`.

> **Sucede a `prisma-seeder-custom`**, que se queda en su `0.2.5`. Esto no es una
> actualización de aquel paquete sino uno nuevo: nombre nuevo, código reescrito
> por completo en TypeScript y un contrato de cliente distinto. Por eso arranca
> en `1.0.0` y no continúa aquella numeración.

### Diferencias con `prisma-seeder-custom` 0.2.x

Quien venga de allí encontrará esto cambiado:

| Qué | `prisma-seeder-custom` 0.2.x | `prisma-seed` 1.0.0 |
|---|---|---|
| `rollback` sin argumentos | revertía **todo** el histórico | revierte solo el último lote. El comportamiento anterior está en `--all` |
| Tabla `SeedExecution` | sin columna `batch` | con `batch`. **Se migra sola**: se detecta y se añade con `DEFAULT 1`, dejando el histórico en el lote 1 |
| Punto de entrada del paquete | `main` | mapa `exports` |
| Contexto del seeder | — | `main()` y `down()` reciben `{ prisma, client, logger, name }`. Los seeders antiguos que ignoran el argumento siguen funcionando |
| Binario | `prisma-seeder-custom` | `prisma-seed` |

Guía de migración: [`MIGRACION.md`](./MIGRACION.md).

### Añadido

- **Inyección de cliente.** `runSeeders(client)` y la clave `client` en
  `seeder.config`. La librería depende de un contrato (`SeedClient`), no de
  `@prisma/client`: funciona igual con `PrismaClient` que con cualquier otro ORM
  que exponga `$queryRawUnsafe` y `$executeRawUnsafe`. Verificado contra
  `@prisma/client@6` y `@zenstackhq/orm@3.9.1` reales.
- **API programática**: `runSeeders`, `rollbackSeeders` y los tipos públicos.
- **Comandos nuevos**: `status`, `fresh [--seed]` y `refresh`.
- **Soporte multi‑motor**: PostgreSQL, MySQL, SQLite y SQL Server, cada uno con
  su dialecto. La 0.2.x solo funcionaba en PostgreSQL.
- **Lotes (`batch`)** y `rollback --step`, `--all`, `--dry-run`.
- **Configuración**: `seeder.config.{ts,mts,js,mjs,cjs}` o la clave
  `prismaSeeder` en `package.json`.
- **Detección automática del lenguaje del seeder** en `generate`, con `--ts` y
  `--js` como escape.
- Autodetección de la raíz del proyecto y del schema (`.prisma` o `.zmodel`).

### Corregido

Catorce defectos de la 0.2.x, cada uno con su test. Los de mayor impacto:

- La tabla que autocreaba quedaba inservible en PostgreSQL: creaba la columna
  como `seedname` y luego consultaba `"seedName"`.
- `run` abortaba con `TypeError` en cualquier proyecto sin la tabla, por el
  interop de `inquirer@12` bajo CommonJS.
- SQL exclusivo de PostgreSQL contra cualquier motor: en MySQL fallaba entero, y
  en SQLite pasaba la sintaxis pero dejaba la clave primaria a `NULL`.
- «Tabla ausente» se detectaba por el código `P2010`, que Prisma usa para
  *cualquier* error de consulta cruda. Ahora se mira el código nativo del motor.
- El seeder y su registro no eran atómicos: un fallo entre medias lo repetía en
  la siguiente ejecución. Ahora van en la misma transacción.
- `generate` abría dos pools de conexión y abortaba sin `@prisma/client`, pese a
  no tocar la base.
- `generate ../../evil` escribía fuera del directorio de seeders.
- `generate UserProfile` emitía `prisma.userprofile`, que no existe.
- Cada seeder generado creaba su propio `PrismaClient` y ninguno se desconectaba.
- El orden de reversión era por `executedAt`, con granularidad de segundo:
  indeterminado para seeders del mismo segundo. Ahora es por `batch DESC, id DESC`.
- Un `catch` en `generate` se tragaba los fallos y salía con código 0.

### Requisitos

- **Node >= 22.12.** Lo marca `commander@15`, que es dependencia de runtime.
  Medido: en Node 18 el CLI ni arranca — `@inquirer/prompts@8` usa `styleText`
  de `node:util`, que no existe allí.

### Limitaciones conocidas

- **Prisma 7** solo por inyección: la construcción automática necesitaría
  resolver *driver adapters*. `peerDependencies` sigue en `>=5 <7`.
- **SQL Server** implementado y con tests unitarios, pero nunca ejecutado contra
  un servidor real.
- **MongoDB** no soportado.
- Sin bloqueo de concurrencia: dos `run` simultáneos pueden repetir un seeder.

[1.0.0]: https://github.com/llopez0522/prisma-seed/releases/tag/v1.0.0
