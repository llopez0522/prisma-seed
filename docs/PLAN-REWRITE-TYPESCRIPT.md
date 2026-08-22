# Plan de reescritura: de `prisma-seeder-custom` a `prisma-seed` v1.0

Fases 0 y 1 completadas. Ver §1.2 (verificación de bugs) y §5 (estado por fase).

La implementación v0.2.4 vivió en `legacy/` durante el port como referencia
ejecutable. Se eliminó al cerrar la fase 5; su contenido está en el historial de
git.

Punto de partida: `prisma-seeder-custom@0.2.4`, JavaScript CommonJS, 5 archivos, sin tests.
Resultado: `prisma-seed@1.0.0`, TypeScript, CLI estilo Laravel, agnóstico al motor y al ORM.

---

## 1. Diagnóstico del código actual

### 1.1 Lo que se conserva

| Decisión | Por qué se mantiene |
|---|---|
| Ledger `SeedExecution` | Modelo correcto: mismo patrón que las migraciones. |
| Nombres con timestamp `YYYYMMDDHHmmss_Nombre` | Da orden lexicográfico estable. |
| Resolución de `@prisma/client` desde el `cwd` del usuario | Evita duplicar el cliente. Correcto. |
| Contrato `main()` / `down()` por archivo | Simple y explícito. Se amplía, no se rompe. |
| Detección ESM/CJS para la plantilla | Buen detalle; se extiende a TypeScript. |

### 1.2 Resultados de la Fase 0 (verificacion ejecutada)

Verificado el 2026-07-18 dentro de Docker (Node 20.20.2, Postgres 16, Prisma 6.19.3),
contra el fixture `.fixtures/pg-cjs` y una base de datos real.

**Correccion importante sobre el diagnostico inicial: la libreria SI funciona en el
camino que documenta el README.** Si el usuario declara el modelo `SeedExecution` en
`schema.prisma` y migra, `run` y `rollback` completan correctamente. Lo que esta roto
son las rutas de conveniencia que se activan cuando la tabla no existe.

| ID | Estado | Evidencia |
|---|---|---|
| B13 | **CONFIRMADO** | `require('inquirer').prompt` es `undefined`; el default esta en `.default`. `run` aborta con `TypeError: inquirer.prompt is not a function` en `run-seeds.js:102` en cualquier proyecto sin la tabla. Exit 1. |
| B1 | **CONFIRMADO** | La tabla autocreada queda con columnas `seedname` / `executedat`; las consultas piden `"seedName"`. Falla con `42703 column "seedName" does not exist`. |
| B4 | **CONFIRMADO** | `generate` en un proyecto sin `@prisma/client` muere con exit 1 antes de escribir nada. Generar un archivo no deberia tocar la base. |
| B9 | **CONFIRMADO** | `generate UserProfile` emite `prisma.userprofile.upsert(...)`. El accesor real es `prisma.userProfile`. |
| B10 | **CONFIRMADO (matizado)** | `generate ../../../../tmp/pwned` resuelve a `/app/.fixtures/pg-cjs/tmp/pwned.js`: escapa de `prisma/seeders`. No logro escritura arbitraria en el sistema; fallo por directorio inexistente. Sigue necesitando validacion. |
| **B2** | **REFUTADO** | Mi hipotesis era erronea. En Postgres, `$queryRawUnsafe` ejecuta INSERT y DELETE sin problema (devuelve `[]`). No es un bug funcional, solo una eleccion de API imprecisa. Se mantiene como mejora de portabilidad, no como defecto. |
| **B5** | **REFUTADO** | Mi hipotesis era erronea. `rollback` termina limpio en 0.23s pese a no llamar a `$disconnect()`; el engine de Prisma no retiene el event loop. Queda como higiene, no como bug. |
| B3 | **CONFIRMADO** | Ejecutado contra los tres motores. Detalle en §1.2.1. MySQL falla por completo; SQLite falla en silencio. |
| **B14** | **NUEVO** | `ensureSeedExecutionTableExists` decide con `error.code === 'P2010'`, pero **Prisma marca P2010 en todo error de raw query**. Se comprobo que tanto `42P01` (tabla ausente) como `42703` (columna ausente) llegan como P2010. La deteccion es insegura: una columna faltante se diagnostica como tabla faltante, el `CREATE TABLE IF NOT EXISTS` no hace nada y se reporta exito. Hay que discriminar por el codigo nativo del motor. |

#### 1.2.1 B3 en detalle: las mismas 4 sentencias en los 3 motores

Se ejecutaron literalmente las sentencias de `run-seeds.js` contra Postgres 16,
MySQL 8 y SQLite (`.fixtures/probe-dialect.js`).

| Sentencia | Postgres 16 | MySQL 8 | SQLite |
|---|---|---|---|
| `CREATE TABLE ... id SERIAL PRIMARY KEY` | OK | **1064 syntax error** | "OK" (ver abajo) |
| `SELECT 1 FROM "SeedExecution"` | OK | **1064 syntax error** | OK |
| `INSERT ... VALUES ($1)` | OK | **1064 syntax error** | OK |
| `INSERT ... VALUES (?)` (control) | — | **1064 syntax error** | OK |

**MySQL: inutilizable, sin excepcion.** Las 4 sentencias fallan, incluida la de
control con `?`. La causa raiz no son los placeholders sino el entrecomillado: en
el `sql_mode` por defecto de MySQL, `"SeedExecution"` es una *cadena literal*, no un
identificador. Haria falta `` `SeedExecution` `` o activar `ANSI_QUOTES`. Como
`runFileSeeds` usa identificadores entrecomillados en cada consulta, la libreria no
funciona en MySQL **ni siquiera por el camino documentado en el README**.

**SQLite: pasa la sintaxis y falla la semantica, que es peor.** SQLite acepta
nombres de tipo arbitrarios por su sistema de afinidad, asi que tolera `SERIAL` sin
rechistar — pero solo `INTEGER PRIMARY KEY` es alias de rowid. Resultado comprobado
(`.fixtures/probe-sqlite-semantics.js`):

```
filas tras dos inserciones:
   {"id":null,"seedName":"seed_a","executedAt":"2026-07-18T10:14:50.000Z"}
   {"id":null,"seedName":"seed_b","executedAt":"2026-07-18T10:14:50.000Z"}
=> ids nulos: 2/2
```

La clave primaria queda **entera a NULL** y nadie se entera. Un fallo silencioso es
mas caro de diagnosticar que el error 1064 de MySQL.

**B6 confirmado de paso**: las dos filas comparten `executedAt` al segundo
(`valores distintos: 1/2`). `ORDER BY "executedAt" DESC` es, literalmente,
indeterminado para seeds ejecutados en el mismo segundo. Justifica pasar a
`ORDER BY batch DESC, id DESC`.

**Conclusion de soporte real de la version 0.2.4:** Postgres unicamente, y solo si
el usuario declara el modelo en `schema.prisma`. El README no lo advierte.

Cadena de fallo reproducida en un proyecto nuevo sin la tabla:
1. `run` -> detecta tabla ausente -> la crea mal (B1) -> aborta en el prompt (B13). Exit 1.
2. `run` de nuevo -> la tabla ya existe -> `42703 column "seedName" does not exist`. Exit 1.

Es decir: sin leer el README con atencion, la herramienta no arranca.

### 1.3 Defectos bloqueantes

| # | Archivo | Defecto | Impacto |
|---|---|---|---|
| B1 | `runner/run-seeds.js:17-23` | El `CREATE TABLE` usa `seedName` sin comillas (Postgres lo pliega a `seedname`), pero todas las consultas usan `"seedName"` entrecomillado. | La rama de autocreación deja la tabla inservible. |
| B2 | `run-seeds.js:87`, `down-seeds.js:32` | `$queryRawUnsafe` para INSERT/DELETE en lugar de `$executeRawUnsafe`. | ~~Escrituras fallan~~ **REFUTADO en Fase 0**: funciona en Postgres. Solo higiene/portabilidad. |
| B14 | `run-seeds.js:14` | `error.code === 'P2010'` como deteccion de "tabla ausente", pero P2010 cubre *todo* error de raw query. | Una columna faltante se diagnostica como tabla faltante y se reporta exito en falso. |
| B3 | `run-seeds.js` (todo) | `SERIAL`, identificadores `"entrecomillados"` y placeholders `$1` son sintaxis exclusiva de Postgres. | No funciona en MySQL, SQLite, SQL Server ni MongoDB. |
| B4 | `run-seeds.js:6`, `down-seeds.js:4` | `getPrismaClient()` se ejecuta al importar el módulo; `cli.js` importa los tres módulos siempre. | `generate` abre 2 pools de conexión y aborta si falta `@prisma/client`. |
| B5 | `down-seeds.js` | Nunca llama a `$disconnect()`. | ~~Proceso colgado~~ **REFUTADO en Fase 0**: sale limpio en 0.23s. Solo higiene. |
| B6 | `down-seeds.js:11` | `ORDER BY "executedAt" DESC` con granularidad de segundo. | Orden de reversión no determinista ante empates. |
| B7 | `run-seeds.js:86-90` | El seed y el registro en el ledger no son atómicos. | Un fallo intermedio provoca doble ejecución. |
| B8 | `utils.js:25-28` | `new URL('file://' + path)` en lugar de `url.pathToFileURL`. | Rompe con `#`, `?` y `%` en la ruta. **Corregido en fase 2.** Ver nota abajo: los espacios NO se ven afectados, mi diagnostico inicial ahi era erroneo. |
| B9 | `generate-seeds.js:37` | `seedName.toLowerCase()` como accesor de modelo. | `UserProfile` genera `prisma.userprofile`, inexistente. |
| B10 | `generate-seeds.js` | Sin validación del nombre. | `generate ../../evil` escribe fuera del directorio. |
| B11 | `generate-seeds.js:122` | `catch` que solo loguea. | Exit code 0 con fallo: invisible en CI. |
| B12 | plantilla generada | Cada seed instancia su propio `PrismaClient`, ninguno se desconecta. | N seeders = N pools de conexión. |
| B13 | `inquirer@12` bajo CJS | **CONFIRMADO en Fase 0**: el default queda en `.default`, así que `inquirer.prompt` es `undefined`. | `run` aborta en todo proyecto sin la tabla `SeedExecution`. El más grave de la lista. |

### 1.4 Defectos menores

- `cli.js:3`: `require('child_process')` sin asignar (código muerto).
- Sin `--help`, `-h`, `--version`; el parseo de argumentos es manual.
- `file.replace('.js', '')` reemplaza la primera ocurrencia, no la extensión.
- La plantilla está fijada a `name` / `email` / `posts`: no compila para ningún otro modelo.
- `package.json` sin `files` → se publica el repo entero (`.npmignore` está en `.gitignore`).
- `main: cli.js` expone un binario con shebang como entrada de librería.
- `test` es un `echo`. Sin lint, sin CI, sin tipos.
- Sin bloqueo de concurrencia: dos `run` simultáneos pueden ejecutar el mismo seed dos veces.
- Directorio `prisma/seeders` fijo por código, sin configuración.

---

## 2. Arquitectura objetivo

```
src/
  cli.ts                    # bootstrap, registro de comandos (commander)
  commands/
    generate.ts             # generate <nombre> [--model] [--ts]
    run.ts                  # run [nombre] [--class] [--step] [--dry-run]
    rollback.ts             # rollback [nombre] [--step] [--all]
    fresh.ts                # fresh [--seed] [--force]
    refresh.ts              # refresh [--seed]
    status.ts               # status
  core/
    config.ts               # carga seeder.config.ts / package.json
    prisma.ts               # cliente singleton, lazy, con disconnect
    ledger.ts               # capa SeedExecution (abstracta por dialecto)
    loader.ts               # carga .js/.mjs/.cjs/.ts (ESM y CJS)
    resolver.ts             # descubre, ordena y filtra seeders
    dialect/
      index.ts              # detección de proveedor desde schema.prisma
      postgres.ts
      mysql.ts
      sqlite.ts
      sqlserver.ts
  templates/                # plantillas ESM / CJS / TS
  types.ts                  # Seeder, SeedContext, Config
  ui/logger.ts              # niveles, --quiet, --verbose, sin emojis forzados
tests/
  unit/                     # vitest
  integration/              # testcontainers: postgres + mysql + sqlite
```

**Build**: `tsup` → `dist/` con ESM + CJS + `.d.ts`. `bin` apunta a `dist/cli.js`.
**Sin `main`**: se añade `exports` con subruta `./config` para tipar `seeder.config.ts`.

### 2.1 Contrato de seeder (retrocompatible)

```ts
import type { SeedContext } from 'prisma-seed';

export const order = 10;                 // opcional: prioridad explícita
export const dependencies = ['User'];    // opcional: ordenación topológica

export async function main({ prisma, logger }: SeedContext) { /* ... */ }
export async function down({ prisma, logger }: SeedContext) { /* ... */ }
```

El `prisma` inyectado resuelve B12: un único cliente para toda la corrida. Los seeders antiguos que ignoran el argumento e instancian su propio cliente siguen funcionando.

### 2.2 Capa de dialecto (resuelve B1, B2, B3)

Se lee el `provider` del bloque `datasource` de `schema.prisma`; el `DATABASE_URL` sirve de respaldo. Cada dialecto implementa:

```ts
interface Dialect {
  createLedgerTable(): string;       // DDL correcto para el motor
  quote(identifier: string): string; // "x" | `x` | [x]
  placeholder(n: number): string;    // $1 | ? | @P1
  truncateAll(tables: string[]): string[];
  resetIdentity(table: string): string | null;
}
```

Toda escritura pasa a `$executeRawUnsafe`; las lecturas siguen en `$queryRawUnsafe`. Preferencia: si el modelo `SeedExecution` está declarado en `schema.prisma` (como pide el README), se usa el cliente tipado y no SQL crudo; el SQL crudo queda solo como respaldo para la autocreación.

### 2.3 Atomicidad (resuelve B7)

Cada seeder corre dentro de `prisma.$transaction`, con el `INSERT` en el ledger como última operación de la misma transacción. Con `--no-transaction` se puede desactivar para seeders que ejecuten DDL o que no toleren transacciones largas.

---

## 3. Superficie de comandos (paridad con Laravel)

| Comando | Equivalente Laravel | Comportamiento |
|---|---|---|
| `generate <nombre>` | `make:seeder` | Genera el archivo. Con `--model User` lee `schema.prisma` y produce campos reales, no la plantilla fija. |
| `run` | `db:seed` | Ejecuta todos los pendientes en orden. |
| `run <nombre>` / `run --class=UserSeeder` | `db:seed --class=` | **Nuevo.** Ejecuta uno solo. Coincidencia parcial e insensible a mayúsculas; si hay ambigüedad, lista candidatos y sale. |
| `run --step=N` | — | **Nuevo.** Ejecuta los N siguientes pendientes. |
| `run --force` | `--force` | Permite ejecución en `NODE_ENV=production`. |
| `run --dry-run` | `--pretend` | **Nuevo.** Muestra qué se ejecutaría sin tocar la base. |
| `rollback` | `migrate:rollback` | Revierte el último *batch* (no todo, ver §3.1). |
| `rollback --all` | `migrate:reset` | Comportamiento actual: revierte todo. |
| `rollback <nombre>` | — | **Nuevo.** Revierte uno solo. |
| `rollback --step=N` | `--step=` | **Nuevo.** Revierte los N últimos. |
| `fresh [--seed]` | **`migrate:fresh --seed`** | **Nuevo.** Ver §3.2. |
| `refresh [--seed]` | `migrate:refresh` | **Nuevo.** `rollback --all` + `run`. Respeta las funciones `down()`. |
| `status` | `migrate:status` | **Nuevo.** Tabla: seeder, estado, batch, fecha. |

### 3.1 Batches

Se añade la columna `batch INTEGER` al ledger (igual que en Laravel). Cada invocación de `run` incrementa el batch; `rollback` sin argumentos revierte solo el último. Es un cambio de comportamiento respecto de v0.2.4, donde `rollback` revertía todo — de ahí el salto a v1.0.0, con `--all` para conservar el comportamiento anterior.

El orden de reversión pasa a `ORDER BY batch DESC, id DESC` (resuelve B6).

### 3.2 `fresh` — el comando que pides

Laravel `migrate:fresh` elimina todas las tablas, vuelve a migrar y, con `--seed`, siembra. Es agnóstico al motor porque lo resuelve el framework.

**Prisma ya ofrece exactamente eso**: `prisma migrate reset --force --skip-seed` borra el esquema, reaplica todas las migraciones y, con ello, resetea los autoincrementales — para todos los proveedores soportados. No hace falta escribir SQL por motor para el camino principal.

```
fresh:
  1. Comprobar NODE_ENV; si es production exigir --force y confirmación explícita.
  2. Mostrar el host de destino de DATABASE_URL y pedir confirmación (salvo --force).
  3. execa('prisma', ['migrate','reset','--force','--skip-seed'])
  4. Asegurar la tabla SeedExecution (queda vacía tras el reset).
  5. Si --seed: ejecutar run().
```

Se añade también `fresh --truncate` como variante que **no** recrea el esquema, solo vacía las tablas y resetea las secuencias. Ahí sí hace falta SQL por dialecto:

- **Postgres**: `TRUNCATE TABLE a, b, c RESTART IDENTITY CASCADE`
- **MySQL**: `SET FOREIGN_KEY_CHECKS=0` → `TRUNCATE` por tabla → `SET FOREIGN_KEY_CHECKS=1`
- **SQLite**: `PRAGMA foreign_keys=OFF` → `DELETE FROM` por tabla → `DELETE FROM sqlite_sequence` → `PRAGMA foreign_keys=ON`
- **SQL Server**: `ALTER TABLE ... NOCHECK CONSTRAINT ALL` → `DELETE` → `DBCC CHECKIDENT(..., RESEED, 0)` → recheck

La lista de tablas se obtiene del DMMF de Prisma (`Prisma.dmmf.datamodel.models`), no del catálogo del motor: así se respetan los `@@map` y no se tocan tablas ajenas.

**Salvaguardas**, dado que este comando destruye datos:
- Bloqueado si `NODE_ENV=production` sin `--force`.
- Confirmación interactiva mostrando host y nombre de la base de datos.
- Rechazo si el host no es local y no se pasa `--force` (heurística sobre `DATABASE_URL`).

---

## 4. Otras mejoras

**Generación desde el schema (resuelve B9, y el problema de la plantilla fija).** `generate --model User` parsea `schema.prisma` vía `@prisma/internals` (`getDMMF`) y emite un `create` con los campos reales, respetando tipos, opcionalidad y relaciones. El nombre del accesor se deriva correctamente en camelCase (`UserProfile` → `prisma.userProfile`), no con `toLowerCase()`.

**Integración opcional con faker.** Si `@faker-js/faker` está instalado en el proyecto, la plantilla usa generadores por tipo de campo. Dependencia opcional, nunca requerida.

**Configuración.** `seeder.config.ts` (o la clave `prismaSeeder` en `package.json`): directorio de seeders, nombre de la tabla del ledger, ruta del schema, modo transaccional, formato de log.

**Soporte de seeders TypeScript.** El cargador detecta `.ts` y usa `tsx`/`jiti` si está disponible; si no, mensaje claro indicando qué instalar.

**Cargador robusto (resuelve B8).** `node:url.pathToFileURL`, con interoperabilidad de `default` para módulos CJS cargados vía `import()`.

**Validación de nombres (resuelve B10).** Lista blanca `/^[A-Za-z][A-Za-z0-9_]*$/`, y verificación de que la ruta resuelta queda dentro del directorio de seeders.

**Códigos de salida (resuelve B11).** 0 éxito, 1 fallo de seeder, 2 error de uso, 3 error de conexión. Los errores se propagan hasta `cli.ts`; nada se traga.

**Bloqueo de concurrencia.** Fila de advisory lock en el ledger (o `pg_advisory_lock` en Postgres) para impedir dos `run` simultáneos.

**Calidad.** Vitest para unidad; testcontainers con Postgres, MySQL y SQLite para integración; ESLint + Prettier; GitHub Actions en Node 18/20/22 con matriz de motores; `changesets` para el versionado.

---

## 5. Fases de ejecución

| Fase | Contenido | Entregable |
|---|---|---|
| **0** | ✅ **COMPLETADA.** Entorno Docker montado (§7) y bugs verificados contra Postgres real. Resultados en §1.2: B1, B4, B9, B10, B13 confirmados; B2 y B5 refutados; B14 descubierto. Pendiente: B3 contra MySQL y SQLite. | Confirmación de los bugs. |
| **1** | ✅ **COMPLETADA.** `tsconfig` estricto, `tsup` (dual ESM+CJS para la API, ESM para el binario), ESLint 9 flat con reglas con tipos, Prettier, Vitest 3 con proyectos unit/integration, CI en GitHub Actions. `package.json` con `files`, `exports`, `bin`, `type: module`. Verificado en Node 18.20.8, 20.20.2 y 22.23.1: build, binario y tests en verde en los tres. | El repo compila en vacío. |
| **2** | ✅ **COMPLETADA.** `errors` (códigos de salida, resuelve B11), `logger`, `loader` (B8), `prisma` (lazy, B4/B5/B12), `resolver` (B10 + bug del `replace`), `schema` (lectura del provider), `config`. 71 tests unitarios y 7 de integración contra Postgres real. | Paridad interna con v0.2.4. |
| **3** | ✅ **COMPLETADA.** Dialectos para Postgres, MySQL, SQLite y SQL Server; `Ledger` con batches, transacciones y migración desde v0.2.4. Cierra B1, B2, B3, B6, B7 y B14. 37 tests unitarios de dialecto + 39 de integración ejecutados **idénticos sobre los tres motores**. | `run` y `rollback` correctos en Postgres, MySQL y SQLite. |
| **4** | ✅ **COMPLETADA.** `generate`, `run` y `rollback` reales con paridad de flags, batches, transacciones y salvaguarda de producción. Cierra B9, B10, B11 y B12. 155 tests unitarios; CLI compilado ejercitado end-to-end contra los tres motores. | Sustituye a v0.2.4 sin regresiones. |
| **5** | ✅ **COMPLETADA.** `status` (solo lectura), `fresh [--seed]` (vacía todas las tablas y resetea autoincrementales, con confirmación y negativa sin TTY) y `refresh`. Dialectos ampliados con `listTables()` y `truncateAll()` que marca sus sentencias de mejor esfuerzo. 289 tests unitarios + 100 de integración. | La funcionalidad estilo Laravel que pides. |
| **6** | Generación desde el schema (B9), inyección de contexto (B12), seeders TS, faker opcional. | Plantillas que compilan de verdad. |
| **7** | Tests de integración con testcontainers en los 3 motores. README reescrito. Guía de migración 0.2 → 1.0. | Publicable. |
| **4b** | ✅ **COMPLETADA.** Inyección de cliente: el cliente deja de construirlo la librería salvo en el camino automático de Prisma. Soporte para ZenStack v3 (schema `.zmodel`, `$transaction` sin opciones, errores `ORMError`, políticas y SQL crudo) y, de paso, para Prisma 7 por inyección. API programática `runSeeders(cliente)`. 260 tests unitarios + 82 de integración. Detalle en [`IMPLEMENTACION.md`](./IMPLEMENTACION.md) §5.6 y §12.1. | La librería es indiferente a cómo se construye el cliente. |

Fases 0–4 restauran corrección; 5–7 añaden lo pedido. Las fases 2 y 3 son las que concentran el riesgo.

La fase 4b no estaba en el plan original: sale de la "alternativa de diseño a
valorar" que apuntaba §9.1 de `IMPLEMENTACION.md`, y era el requisito para
soportar ZenStack v3 sin acoplar la librería a él.

---

### 5.1 Nota de la fase 2: correccion sobre B8

Al escribir el test que fija B8 descubri que mi descripcion original era imprecisa.
Afirme que la concatenacion `'file://' + ruta` fallaba "con espacios o `#`". Los
espacios **no** son un problema: `new URL()` los normaliza a `%20` igual que
`pathToFileURL`, y la ruta sobrevive intacta. Lo verifique en los dos sentidos.

Los caracteres que si corrompen la ruta son otros tres:

| Caracter | Que ocurre con la concatenacion |
|---|---|
| `#` | Inicia un fragmento: `/tmp/con#x/seed.mjs` se trunca a `/tmp/con`. |
| `?` | Inicia un query string: mismo truncamiento. |
| `%` | Se interpreta como escape ya existente y se decodifica de mas. |

El fallo con espacios que observe en la verificacion inicial venia de la `#` que
habia en la misma ruta de prueba, no de los espacios. El bug es real y la
correccion es la misma; solo cambia el motivo. Queda fijado en
`tests/unit/loader.test.ts`.

**Limitacion de cobertura conocida**: la carga end-to-end de una ruta con esos
caracteres no se puede verificar en la suite unitaria, porque Vitest enruta todo
`import()` dinamico por su propio module runner y no resuelve URLs `file://` con
escapes de porcentaje. Se comprobo a mano contra Node 20.20.2 real (el nuevo loader
carga la ruta, el metodo de la v0.2.4 falla con `ERR_MODULE_NOT_FOUND`) y la
cobertura automatizada llega en la fase 7, ejecutando el CLI como proceso.

### 5.2 Nota de la fase 2: desacople del tipo `PrismaClient`

El nucleo **no** importa `PrismaClient` de `@prisma/client`. Ese tipo solo existe
tras `prisma generate`; en un proyecto sin cliente generado degrada silenciosamente
a `any`, que anula el sentido de portar a TypeScript (el lint lo destapo: 19
errores de `no-unsafe-*` en codigo que parecia tipado).

En su lugar hay una interfaz estructural `PrismaLike` con las cinco operaciones que
la libreria necesita, y `SeedContext<TClient>` es generico para que un seeder en
TypeScript pueda pedir su cliente ya generado y conservar el autocompletado de sus
modelos.

---

### 5.3 Nota de la fase 3: el antes y el despues por motor

Las mismas cuatro sentencias de la fase 0, ahora emitidas por la capa de dialecto:

| | v0.2.4 | v1.0 (fase 3) |
|---|---|---|
| **Postgres** | Autocreación deja `seedname`/`executedat`; consultas piden `"seedName"` → `42703` | Todas las columnas entrecomilladas. 13/13 tests |
| **MySQL** | Las 4 sentencias fallan con `1064`. Inutilizable | Acento grave como delimitador, `AUTO_INCREMENT`. 13/13 tests |
| **SQLite** | Sintaxis aceptada, `id` entero a NULL. Fallo silencioso | `INTEGER PRIMARY KEY AUTOINCREMENT`. 13/13 tests |

Decisiones que conviene registrar:

- **B2, ya refutado, se aplica igualmente.** `$queryRawUnsafe` funciona para
  escrituras en Postgres, pero `$executeRawUnsafe` devuelve el número de filas
  afectadas, y eso permite que `remove()` distinga "borré el registro" de "no
  existía". Se adopta por el valor de retorno, no por corregir un fallo.
- **B14 discrimina por código nativo**, no por el código de Prisma. Postgres
  `42P01`, MySQL `1146`, SQL Server `208`. SQLite no expone códigos granulares
  (todo llega como `1`), así que ahí hay que mirar el texto del mensaje: es frágil
  por naturaleza, pero es lo único que da el motor.
- **Migración de ledgers v0.2.4**: quien siguiera el README tiene la tabla
  declarada en su `schema.prisma`, sin columna `batch`. `ensureTable()` detecta el
  caso y hace `ALTER TABLE ADD COLUMN batch DEFAULT 1`, conservando el histórico
  en el batch 1. Verificado en los tres motores.

**Hallazgo durante las pruebas**: en Postgres, reutilizar una conexión a través de
ciclos DROP/CREATE de la misma tabla provoca `0A000 cached plan must not change
result type`. Se comprobó que **no afecta a producción** — tanto preparar la
consulta antes del `ALTER` como el flujo real del CLI (`ensureTable` → `ALTER` →
primera consulta) funcionan sin error. El disparador es el ciclo repetido sobre una
conexión viva, que solo ocurre en la suite. Ese test usa un cliente aislado y el
motivo queda documentado en el propio archivo.

---

### 5.4 Nota de la fase 4: verificación end-to-end del CLI compilado

No basta con que compile: se ejecutó `dist/cli.js` contra bases reales.

| Comprobación | Resultado |
|---|---|
| `generate UserProfile` | Emite `prisma.userProfile` — B9 cerrado |
| `generate` sin `@prisma/client` | exit 0, archivo creado — B4 cerrado |
| `generate ../../../../tmp/pwned` | Rechazado, exit 2 — B10 cerrado |
| Seeder que lanza | exit 1 con mensaje — B11 cerrado |
| **Seeder que inserta y luego falla** | **0 filas, 0 registros en el ledger** — B7 cerrado |
| `run` dos veces | Segunda: "No hay seeders pendientes" |
| `rollback` con dos batches | Revierte solo el último (semántica Laravel) |
| `rollback --all` | Revierte todo, en orden inverso |
| Nombre ambiguo (`run 2024`) | exit 2 listando los candidatos |
| **Ciclo completo en MySQL 8** | **run + rollback correctos** — inviable en v0.2.4 |
| **Ciclo completo en SQLite** | **run + rollback correctos** — corrupto en v0.2.4 |

**Nota metodológica**: la primera prueba de atomicidad dio "FUGA DE DATOS" con un
registro huérfano en el ledger. Al investigarlo resultó ser un fallo de mi
secuencia de prueba, no del producto: había borrado los archivos de seeder *antes*
de lanzar `rollback --all`, así que el rollback no encontró el archivo y dejó el
registro (comportamiento intencionado), con un aviso que yo mismo había silenciado
con `>/dev/null`. Repetida limpiamente, la atomicidad es correcta. Queda anotado
porque el impulso de "arreglar el código" ante un test rojo habría introducido un
bug real.

**Decisión pendiente**: `legacy/` sigue en el repo. El plan preveía borrarlo al
cerrar esta fase, pero no urge — su contenido está en el historial de git y no
estorba (está excluido de lint, build y publicación). Se deja para que puedas
comparar si quieres.

---

## 6. Compatibilidad y publicación

**Cambios que rompen** (justifican v1.0.0):
1. `rollback` sin argumentos revierte el último batch, no todo. Mitigación: `--all` y aviso explícito en la primera ejecución.
2. El ledger gana la columna `batch`. Mitigación: migración automática al arrancar; los registros existentes quedan en batch 1.
3. El `main` de librería desaparece en favor de `exports`. Solo afecta a quien importara `cli.js`, algo que nadie debería hacer.

**Compatible hacia atrás**: los seeders `.js` existentes con `main()`/`down()` siguen funcionando sin tocarlos.

**Recomendado**: publicar `1.0.0-beta.0` bajo el tag `next` antes del estable.

---

## 7. Entorno de desarrollo (Docker)

La maquina de desarrollo no tiene Node instalado y no debe instalarlo. Todo el
toolchain vive en contenedores.

| Archivo | Rol |
|---|---|
| `docker/Dockerfile.dev` | Imagen base `node:${NODE_VERSION}-bookworm-slim`. Debian en vez de Alpine porque los engines de Prisma dependen de OpenSSL y glibc. Incluye clientes `psql` y `mysql` para inspeccion manual. |
| `docker-compose.yml` | Servicios `dev` (Node 20), `node18` y `node22` (verificacion de interop en los extremos del rango de `engines`), `postgres:16` y `mysql:8` con healthchecks. |
| `dx` | Wrapper de conveniencia. `./dx npm install`, `./dx shell`, `./dx psql`, `./dx --node18 <cmd>`, `./dx down`. |
| `.fixtures/pg-cjs/` | Proyecto Prisma minimo (CommonJS + Postgres) usado como banco de pruebas del CLI. |

Decisiones relevantes:

- **`node_modules` en volumenes nombrados**, nunca en el bind mount. La maquina local
  queda sin artefactos de Node y los tres servicios de Node mantienen arboles de
  dependencias independientes.
- **Datos de las bases en `tmpfs`**: cada arranque parte de cero, que es justo lo que
  quieren los tests de integracion, y ademas es mas rapido.
- **Puertos remapeados** (`55432`, `53306`) para no chocar con instancias locales.
- `.gitignore` corregido: `prisma/` -> `/prisma/`, porque el patron original ignoraba
  los `schema.prisma` de los fixtures. Tambien se elimino `tests/`, que habria
  bloqueado la Fase 7.

Comandos de la verificacion de Fase 0, reproducibles:

```bash
./dx npm install
./dx bash -c "cd /app/.fixtures/pg-cjs && npm install && npx prisma db push"
./dx bash -c "cd /app/.fixtures/pg-cjs && node /app/cli.js generate user"
./dx bash -c "cd /app/.fixtures/pg-cjs && node /app/cli.js run"
./dx psql -c '\d "SeedExecution"'
```

---

## 8. Preguntas abiertas

1. `rollback` por batches, ¿o mantener «revierte todo» como valor por defecto para no romper a los usuarios actuales?
2. ¿Soportar SQL Server y MongoDB en v1.0, o solo Postgres/MySQL/SQLite y dejar el resto para v1.1? (MongoDB no tiene transacciones ni autoincrementales: requiere un camino aparte.)
3. ¿Publicar solo ESM (más simple, Node 18+) o build dual ESM+CJS?
4. ¿Debe `fresh` invocar el binario `prisma` como subproceso, o exigir `@prisma/internals` como peer dependency y llamar a la API programática?
