# Implementación — referencia técnica

Documento de referencia para correcciones, ajustes y trabajo futuro sobre
`prisma-seed`. Describe **lo que hay construido**, por qué está hecho así,
y dónde tocar para cambiarlo.

- Para el diagnóstico de la v0.2.4 y el plan por fases: [`PLAN-REWRITE-TYPESCRIPT.md`](./PLAN-REWRITE-TYPESCRIPT.md)
- Cómo probar el paquete sin publicarlo: §10.
- Última actualización: `status`, `fresh` y `refresh`; versión 2.0.0 lista para publicar.

---

## 1. Estado

| | |
|---|---|
| Paquete | `prisma-seed` — nombre nuevo, sucede a `prisma-seeder-custom` (que se queda en su `0.2.5`) |
| Versión en `package.json` | `1.0.0` (sin publicar) |
| Node | `>=22.12` — lo impone `commander@15`. Verificado en 22.23.2 y 24.19.0 |
| Toolchain | TypeScript 6.0.3 · ESLint 10.9 · Vitest 4.1 · tsup 8.5 · commander 15 |
| Fases completadas | 0, 1, 2, 3, 4, 5 |
| Fases pendientes | 6 (generación desde schema), 7 (CI de integración) |
| Código fuente | ~3.200 líneas TypeScript en 29 módulos |
| Tests | 289 unitarios + 100 de integración + 9 contra un ORM real externo |
| Motores verificados | Postgres 16, MySQL 8, SQLite |
| Motores implementados sin verificar | SQL Server |
| Clientes soportados | Cualquiera que cumpla el contrato `SeedClient`. Verificados: `PrismaClient` 5/6 y `ZenStackClient` 3.9.1 (§5.6) |
| Versión de Prisma soportada | 5 y 6 sin configurar. **Prisma 7 funciona inyectando el cliente** (§9.1) |
| Bugs de la v0.2.4 | 14 identificados, 14 resueltos (2 resultaron ser falsos positivos míos) |

**Todos los comandos están operativos**: `generate`, `run`, `status`, `rollback`,
`fresh`, `refresh`.

---

## 2. Entorno de desarrollo

**La máquina local no tiene Node y no debe tenerlo.** Todo el toolchain vive en
contenedores. El wrapper `./dx` es el único punto de entrada.

```bash
./dx npm install              # instalar dependencias
./dx npm run check            # typecheck + lint + tests unitarios
./dx npm run test:integration # tests contra Postgres, MySQL y SQLite reales
./dx npm run build            # compilar a dist/
./sandbox all                 # probar el paquete empaquetado de verdad (§10)
./dx shell                    # bash dentro del contenedor
./dx psql                     # cliente Postgres sobre la base de pruebas
./dx mysql                    # cliente MySQL
./dx --node24 <cmd>           # ejecutar en Node 24 (el otro extremo soportado)
./dx down                     # parar y limpiar
```

### Piezas

| Archivo | Rol |
|---|---|
| `docker/Dockerfile.dev` | Imagen `node:${NODE_VERSION}-bookworm-slim`. **Debian, no Alpine**: los engines de Prisma dependen de OpenSSL y glibc. Trae `psql` y `mysql` para inspección manual. |
| `docker-compose.yml` | Servicios `dev` (Node 22, el mínimo soportado), `node24`, `postgres:16`, `mysql:8`. |
| `dx` | Wrapper del toolchain. Lee de las primeras líneas su propia ayuda. |
| `sandbox` | Banco de pruebas del paquete empaquetado (§10). Misma convención que `dx`. |
| `.fixtures/pg-cjs`, `mysql-cjs`, `sqlite-cjs` | Proyectos Prisma mínimos, uno por motor, usados como banco de pruebas. |
| `.fixtures/probe-dialect.js` | Reproduce las 4 sentencias de la v0.2.4 contra el motor configurado. Sirve para volver a demostrar B3. |
| `.fixtures/probe-sqlite-semantics.js` | Demuestra que `SERIAL` en SQLite deja la clave primaria a NULL. |

### Decisiones del entorno

- **`node_modules` en volúmenes nombrados**, nunca en el bind mount: la máquina
  local no acumula artefactos y cada versión de Node mantiene su propio árbol.
- **Datos de las bases en `tmpfs`**: cada arranque parte de cero. Rápido y es lo
  que quieren los tests de integración.
- **Puertos remapeados** (`55432`, `53306`) para no chocar con instancias locales.

### Variables de entorno

Las define `docker-compose.yml`. Los tests de integración fallan con un mensaje
explícito si faltan.

| Variable | Uso |
|---|---|
| `DATABASE_URL` | La que lee el cliente de Prisma del fixture activo |
| `POSTGRES_URL` / `MYSQL_URL` / `SQLITE_URL` | Las que usan los tests multi-motor |

---

## 3. Mapa del código

```
src/
├── cli.ts                  Punto de entrada. ÚNICO sitio que decide códigos de salida.
├── index.ts                API pública: runSeeders/rollbackSeeders + tipos + defineConfig.
├── api.ts                  API programática. `runSeeders(cliente, opciones)`.
├── types.ts                Contratos: SeedClient, SeedContext, SeederConfig…
├── version.ts              Versión leída de package.json.
├── commands/
│   ├── context.ts          Arranque compartido: config + provider + dialecto + ledger.
│   ├── generate.ts         `generate` (no toca la base de datos).
│   ├── run.ts              `run`  — validación de flags y orquestación.
│   ├── rollback.ts         `rollback` — íd.
│   ├── status.ts           `status` — el único que NO escribe nada.
│   ├── fresh.ts            `fresh` — vacía TODAS las tablas. Ver §4.
│   └── refresh.ts          `refresh` — revierte todo y vuelve a sembrar.
├── core/
│   ├── errors.ts           CliError/UsageError/ConnectionError + tabla de exit codes.
│   ├── logger.ts           Niveles, --quiet/--verbose, salida inyectable.
│   ├── config.ts           Carga y fusiona configuración; resuelve rutas.
│   ├── project.ts          Busca la raíz del proyecto y su schema (.prisma o .zmodel).
│   ├── schema.ts           Extrae el `provider` del bloque datasource.
│   ├── client.ts           Sabor del cliente, transacción, cierre y resolución. Ver §5.6.
│   ├── context.ts          Monta el runtime compartido por el CLI y por la API.
│   ├── prisma.ts           Construcción automática de PrismaClient desde el cwd del usuario.
│   ├── loader.ts           Importa seeders (.js/.mjs/.cjs/.ts) y normaliza el interop.
│   ├── resolver.ts         Descubre, ordena y busca seeders. Valida nombres.
│   ├── naming.ts           PascalCase / camelCase / timestamps.
│   ├── ledger.ts           Tabla SeedExecution: batches, registro, migración.
│   ├── tables.ts           Inventario de tablas para `fresh`, con exclusiones.
│   ├── status.ts           Cruza disco y ledger. Pura, sin efectos.
│   ├── runner.ts           Motor de ejecución y reversión. El corazón.
│   └── dialect/
│       ├── types.ts        Interfaz Dialect + extracción de códigos nativos.
│       ├── index.ts        Fábrica por provider.
│       ├── postgres.ts  mysql.ts  sqlite.ts  sqlserver.ts
└── templates/
    └── seeder.ts           Plantillas ESM / CJS / TS.
```

### Reglas de dependencia

- `core/` **no importa** de `commands/` ni de `cli.ts`.
- `api.ts` tampoco importa de `commands/`: usa `core/context.ts` directamente.
- `core/` **nunca llama a `process.exit`**: lanza `CliError`. Solo `cli.ts` sale.
- `core/dialect/` no importa nada de `core/` salvo sus propios tipos.
- Nada en `src/` importa `PrismaClient` de `@prisma/client` (ver §6.2).
- **`core/client.ts` es el único módulo que trata con el ORM.** Ledger, runner y
  comandos ven un `SeedClient` y nada más.
- **Nunca se pregunta qué ORM es un cliente, solo qué sabe hacer.** No hay ni una
  comprobación de marca en `src/`.

---

## 4. Flujos

### `generate <nombre>`

No abre conexión ni exige `@prisma/client`. Es deliberado (B4).

```
validar nombre (lista blanca)      resolver.assertValidSeedName
  └─ rechaza ../,  /,  \,  vacío,  que no empiece por letra
cargar config                      config.loadConfig
crear directorio si falta
detectar variante                  generate.detectFlavor
  └─ --ts  >  package.json type:module → esm  >  cjs
componer nombre de archivo         naming.buildSeedFileName → 20240105090807_User.js
segunda barrera de ruta            path.dirname(resuelto) === seedersDir
si ya existe → CliError (exit 2)
renderizar y escribir              templates.renderTemplate
```

### `run [nombre]`

```
guardProduction(--force)           NODE_ENV=production sin --force → exit 2
parsear y validar flags            nombre y --step son excluyentes
createContext                      config → provider (.prisma o .zmodel) → dialecto
                                   → resolveSeedClient (config.client o
                                     @prisma/client) → Ledger
ledger.ensureTable()               crea si falta; si viene de v0.2.4, ALTER ADD batch
runner.runSeeders()
  ├─ discoverSeeders               ordena: timestamp asc, luego nombre
  ├─ ledger.appliedNames()         Set de lo ya ejecutado
  ├─ filtrar pendientes            o resolver --class / nombre concreto
  ├─ aplicar --step
  ├─ --dry-run → listar y salir
  ├─ batch = ledger.nextBatch()
  └─ por cada seeder:
        loadSeederModule
        exige main()
        runInTransaction(cliente, fn, {timeout}):
            main({ prisma: tx, client: tx, logger, name })
            ledger.record(name, batch, tx)     ← misma transacción (B7)
closeContext()                     en finally; ver §5.6 (ciclo de vida)
```

### `rollback [nombre]`

```
guardProduction(--force)
nombre / --step / --all son mutuamente excluyentes
si la tabla no existe → aviso y salida limpia
seleccionar registros:
  nombre  → coincidencia exacta o parcial; si es ambigua, exit 2
  --all   → todo el histórico
  --step N→ los N últimos
  (nada)  → SOLO el último batch     ← semántica de Laravel migrate:rollback
por cada registro (orden: batch DESC, id DESC):
  si falta el archivo → aviso, se CONSERVA el registro, continuar
  si no exporta down() → aviso, se conserva, continuar
  $transaction: down(...) + ledger.remove(...)
```

### `fresh [--seed]`

```
guardProduction(--force)
createContext
listUserTables()                  descubre las tablas; excluye las que empiezan
                                  por `_` (registro de migraciones del ORM) y
                                  las de `freshExclude`
--dry-run → listar y salir
si no --force → confirmar por terminal
                                  sin TTY se NIEGA: nunca asume que sí
dialect.truncateAll(tablas)       una sentencia tras otra; se perdona el fallo
                                  solo si el dialecto la marcó `optional` Y el
                                  motor dice "tabla ausente"
--seed → ledger.ensureTable() + runSeeders()
```

**Vacía, no recrea el esquema.** Laravel puede hacer `drop` porque es dueño de
las migraciones; aquí las tiene el ORM del proyecto, y recrearlas exigiría
invocar su CLI — acoplando la librería a una implementación concreta, que es
justo lo que no se hace en ningún otro sitio. `TRUNCATE ... RESTART IDENTITY`
deja el mismo resultado observable sin tocar el esquema.

### `status`

```
createContext
discoverSeeders()                 lo que hay en disco
ledger.tableExists() → all()      lo que dice el ledger; si no hay tabla, nada
buildStatus()                     cruza ambos: applied / pending / missing-file
```

**Es el único comando que no escribe nada**, ni siquiera crea la tabla del
ledger. Un comando de consulta que modifica la base es una trampa.

### `refresh`

```
guardProduction(--force)
rollbackSeeders({ all: true })    llama al down() de cada uno
runSeeders()
```

Es la alternativa quirúrgica a `fresh`: solo deshace lo que los seeders
declararon, así que respeta el resto de los datos. A cambio depende de que los
`down()` estén bien escritos; `fresh` no depende de nada.

---

## 5. Contratos y puntos de extensión

### 5.1 Añadir un motor de base de datos

1. Crear `src/core/dialect/<motor>.ts` implementando `Dialect`
   ([`src/core/dialect/types.ts`](../src/core/dialect/types.ts)).
2. Registrarlo en el mapa `DIALECTS` de `src/core/dialect/index.ts`.
3. Añadir el valor al tipo `Provider` en `src/types.ts` y al `switch` de
   `normalizeProvider` en `src/core/schema.ts`.
4. Añadir un fixture `.fixtures/<motor>-cjs/` y el servicio en `docker-compose.yml`.
5. Añadirlo a `ENGINES` en `tests/integration/helpers/clients.ts`: los 13 tests de
   `ledger.test.ts` se ejecutan automáticamente sobre el nuevo motor.

Los ocho métodos de `Dialect`:

| Método | Qué resuelve |
|---|---|
| `quote(id)` | Delimitador de identificadores. **No es cosmético**: usar el equivocado rompe MySQL por completo. |
| `placeholder(n)` | `$1` / `?` / `@P1` |
| `createLedgerTable(t)` | DDL idempotente con los tipos correctos del motor |
| `columnExists(t, c)` | Consulta para detectar ledgers de v0.2.4 sin `batch` |
| `addBatchColumn(t)` | DDL de migración |
| `isMissingTableError(e)` | Discrimina por **código nativo**, no por el de Prisma |
| `truncateAll(tables)` | Vaciado + reseteo de autoincrementales (lo usará `fresh --truncate`) |

### 5.2 Añadir un comando

1. Crear `src/commands/<nombre>.ts` que exporte `<nombre>Command(args, options)`.
2. Si necesita base de datos, arrancar con `createContext(options)` y cerrar con
   `disconnectPrisma()` en un `finally`.
3. Registrarlo en `buildProgram()` de `src/cli.ts`, sustituyendo el `pending(...)`.
4. Lanzar `UsageError` para errores de uso y `CliError` para fallos de ejecución.
   **Nunca llamar a `process.exit`.**

### 5.3 Añadir una opción de configuración

1. Campo en `SeederConfig` (`src/types.ts`).
2. Valor por defecto en `DEFAULT_CONFIG` (`src/core/config.ts`). Si no debe tener
   uno, añadirlo al `Omit<...>` del tipo de `DEFAULT_CONFIG`.
3. Validación en `validate()` si admite valores inválidos.
4. Si se puede pasar por CLI, mapearla en `createContext` (`src/commands/context.ts`).
5. Si la API programática debe aceptarla, ya lo hace: `SeedApiOptions.config` es
   un `UserSeederConfig` completo.

Precedencia: `DEFAULT_CONFIG` < `package.json#prismaSeeder` < `seeder.config.*` < flags de CLI.

### 5.4 Configuración disponible

| Clave | Por defecto | Notas |
|---|---|---|
| `seedersDir` | `prisma/seeders` | Igual que v0.2.4 |
| `schemaPath` | autodetectado | `prisma/schema.prisma` → `zenstack/schema.zmodel` → `schema.zmodel` → `prisma/schema.zmodel`. Antes gana `zenstack.schema` o `prisma.schema` de `package.json`. Si no hay nada, `prisma/schema.prisma` |
| `ledgerTable` | `SeedExecution` | Validado como identificador SQL |
| `transactional` | `true` | `--no-transaction` lo desactiva |
| `transactionTimeout` | `300000` (5 min) | Ver §6.4. **No aplica a ZenStack v3** |
| `provider` | (deducido del schema) | Fijarlo salta la lectura del schema |
| `client` | (ninguno) | Cliente o fábrica de cliente. El punto de inyección. Ver §5.6 |
| `closeClient` | `true` | Solo el CLI. A `false`, no cierra el cliente inyectado |
| `seederLanguage` | (deducido) | `ts` / `esm` / `cjs`. Salta la deducción de §5.7 |
| `clientType` | (Prisma) | Tipado del cliente en los seeders TypeScript. Ver §5.8 |
| `freshExclude` | `[]` | Tablas que `fresh` no debe vaciar. Las que empiezan por `_` ya quedan fuera siempre |

### 5.5 Contrato de seeder

Retrocompatible con v0.2.4: un módulo con `main()` y `down()` sigue siendo válido,
ignore o no el contexto.

```js
export async function main({ prisma, client, logger, name }) { }
export async function down({ prisma, client, logger, name }) { }
export const order = 10;                  // opcional, aún NO lo usa el runner
export const dependencies = ['User'];     // opcional, aún NO lo usa el runner
```

`client` es **la misma referencia** que `prisma`, con un nombre neutral para
proyectos que no usan Prisma directamente. Ningún seeder debe construir su propio
cliente: recibe el del proceso.

> `order` y `dependencies` se leen y se tipan, pero **el runner todavía no los
> aplica**: el orden sigue siendo por prefijo de timestamp. Implementarlo es
> trabajo pendiente (§9).

### 5.6 Inyección del cliente

El cliente **no lo construye la librería salvo que no le quede otra**. Ese es el
cambio de arquitectura que permite soportar Prisma tradicional y ZenStack v3 con
la misma infraestructura.

#### Precedencia

| Orden | Origen | Cuándo |
|---|---|---|
| 1 | `runSeeders(cliente)` | API programática |
| 2 | `client` en `seeder.config.*` | CLI en un proyecto que construye su cliente |
| 3 | `new PrismaClient()` desde el `cwd` | CLI en un proyecto Prisma. El camino de siempre |

Todo pasa por `resolveSeedClient()` en `src/core/client.ts`, que se invoca **una
sola vez por ejecución**. Ese objeto es el que recibe el ledger y el que se inyecta
en cada seeder.

#### Qué se le exige al cliente

Solo dos operaciones, las que necesita el ledger:

```ts
interface RawSqlClient {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}
```

`$connect`, `$disconnect` y `$transaction` son **opcionales y se detectan en
tiempo de ejecución**. Un cliente sin `$transaction` funciona con
`transactional: false`; uno sin `$disconnect` simplemente no se cierra.

#### Por qué basta con capacidades

La librería **no pregunta nunca qué ORM es el cliente**. No hay ni una rama
`if (isPrisma)` / `if (isZenStack)` en `src/`. Solo pregunta qué sabe hacer:

```ts
capabilitiesOf(client)   // { transactions, connect, disconnect }
```

Que eso baste no es una suposición: se midió sobre `@prisma/client@6` y
`@zenstackhq/orm@3.9.1` instalados.

| Aspecto | Prisma 5/6 | ZenStack 3.9.1 | Qué hace la librería |
|---|---|---|---|
| `$queryRawUnsafe` / `$executeRawUnsafe` | `PrismaPromise<T>` | `ZenStackPromise<T>` | Nada: ambos extienden `Promise<T>` |
| `$transaction(fn, options?)` | sí | sí | Una sola llamada, sin ramas |
| Opciones que aplica | `maxWait`, `timeout`, `isolationLevel` | solo `isolationLevel` | **Se envían siempre las mismas**; el que no entiende una la ignora |
| Cliente dentro de la transacción | `Omit<PrismaClient, ITXClientDenyList>` | `Omit<ClientContract, '$transaction' \| '$connect' \| '$disconnect' \| '$use'>` | Por eso esos miembros son opcionales en `SeedClient` |
| `$connect` / `$disconnect` | sí | sí | Opcionales y comprobados antes de llamar |
| Código nativo del motor | `error.meta.code` | `dbErrorCode` | `nativeErrorCodes()` recoge ambos y recorre `cause` |
| Construcción | `new PrismaClient()` | dialecto + driver + pool | Por eso existe la inyección |

**La pieza que elimina la última rama**: se comprobó en ejecución que un
`ZenStackClient` real recibe `{ timeout }`, lo ignora y completa la transacción
sin error — solo lee `isolationLevel`. Así que enviar siempre el mismo objeto es
correcto, y la librería no necesita saber con quién habla. Una versión anterior
detectaba el «sabor» del cliente para filtrar las opciones; se eliminó.

Dos cosas que la documentación pública de ZenStack v3 dice de otra manera, y
donde manda el paquete instalado:

| Punto | Documentación | Paquete 3.9.1 |
|---|---|---|
| Opciones de `$transaction` interactivo | no menciona ninguna | `options?: { isolationLevel? }` |
| `timeout` | — | no existe (`TS2769` si se pasa desde TypeScript) |

#### Fricción conocida: `tsx` y los alias de `tsconfig`

Si el módulo del cliente importa algo por un alias de `paths` (`@/…`), medido:

| Cómo se lanza el CLI | Resultado |
|---|---|
| `node --import tsx/esm .../cli.js` | **falla** en `resolveTsPathsSync` |
| `npx tsx .../cli.js` | funciona |

No es un defecto de la librería —el fallo ocurre al importar el módulo del
consumidor— pero es el primer muro, así que las tres pistas que lo mencionan
(`loader.ts`, `config.ts`, `client.ts`) recomiendan el binario.

#### Ciclo de vida

| Quién creó el cliente | Quién lo cierra |
|---|---|
| La librería (`new PrismaClient()`) | La librería, siempre |
| La configuración (`client`) | El **CLI**, porque es dueño del proceso. `closeClient: false` lo evita |
| Quien llama a `runSeeders()` | **Nadie más que él**. La API nunca cierra lo prestado |

Una sola instancia por ejecución en los tres casos.

Por qué importa: en una aplicación real el cliente es un módulo compartido con un
pool detrás. Si `runSeeders()` lo cerrara, el siguiente uso moriría con *«Cannot
use a pool after calling end»*. Verificado contra un ORM real: el test
`deja el cliente utilizable: no cierra lo que no ha creado` consulta la base
después de `runSeeders` + `rollbackSeeders` y comprueba que sigue viva.

### 5.7 En qué lenguaje se escribe el seeder

`generate` distinguía ESM de CommonJS por `package.json#type`, pero TypeScript
había que pedirlo con `--ts` **en cada invocación**. Era incoherente: si el
proyecto es TypeScript, el seeder debe salir en TypeScript sin recordarlo.

Ahora hay una escalera de señales, todas hechos comprobables del proyecto:

| # | Señal | Gana porque |
|---|---|---|
| 1 | `--ts` / `--js` | Lo pide quien ejecuta el comando |
| 2 | `seederLanguage` en la configuración | Lo decidió el proyecto |
| 3 | **La extensión de los seeders que ya existen** | Lo coherente es escribir el siguiente igual que el último |
| 4 | Hay `tsconfig.json` | El proyecto es TypeScript |
| 5 | `package.json#type` | ESM o CommonJS |

`.js` no cuenta como señal en el peldaño 3: no dice si el proyecto es ESM o
CommonJS, así que se sigue bajando.

`generate` **imprime cuál de los cinco decidió**, para que nunca sea un misterio:

```
✓ 20260822120506_Tarifas.ts
  zenstack/seeders/20260822120506_Tarifas.ts
  lenguaje: ts (los seeders que ya hay son ts)
```

`--js` existe como escape: un proyecto con `tsconfig.json` que prefiera seeders en
JavaScript plano —para no depender de un loader al ejecutarlos— lo fija de una vez
con `seederLanguage: 'esm'`.

### 5.8 Tipado del cliente en los seeders generados

`generate --ts` emitía `import type { PrismaClient } from '@prisma/client'` sin
alternativa, lo que produce un archivo que no compila en un proyecto sin ese
paquete. Ahora:

- Con `clientType` en la configuración, se emite ese import y ese tipo.
- Sin él, la pregunta no es qué ORM usa el proyecto sino algo comprobable:
  **¿puede resolver `@prisma/client`?** (`hasPrismaClient()`).
  - Si puede, se emite lo de siempre.
  - Si no, se declara una **interfaz local mínima** con los dos métodos que usa
    la plantilla y un comentario con la línea exacta que hay que sustituir
    (`type AppClient = typeof db`). Compila sin `any`.

---

## 6. Decisiones de diseño

### 6.1 `core/` lanza, `cli.ts` sale

La v0.2.4 tenía `process.exit(1)` repartidos por módulos de librería y, a la vez,
un `catch` en `generate` que solo logueaba, dejando exit 0 ante un fallo real (B11).
Ahora hay una tabla de códigos en `src/core/errors.ts`:

| Código | Significado |
|---|---|
| 0 | Éxito |
| 1 | Un seeder falló |
| 2 | Uso incorrecto: argumento inválido, nombre ambiguo, comando no implementado |
| 3 | No se pudo resolver o conectar el cliente de Prisma |

`CliError` lleva además un `hint` opcional que se imprime atenuado bajo el mensaje.

### 6.2 No se importa `PrismaClient`

`import type { PrismaClient } from '@prisma/client'` **degrada silenciosamente a
`any`** en un proyecto sin cliente generado. Lo destapó el lint: 19 errores
`no-unsafe-*` en código que aparentaba estar tipado. Todo el núcleo habría tenido
tipado ficticio.

En su lugar, `SeedClient` (`src/types.ts`) declara estructuralmente lo que la
librería necesita, y `SeedContext<TClient = SeedClient>` es genérico para que un
seeder en TypeScript pida su cliente real:

```ts
// Prisma tradicional
export async function main({ prisma }: SeedContext<PrismaClient>) {
  await prisma.user.create({ ... });   // autocompletado completo
}

// ZenStack v3
export async function main({ prisma }: SeedContext<typeof db>) {
  await prisma.user.create({ ... });
}
```

Tres decisiones de tipado que conviene no deshacer:

1. **`$transaction` se declara con su firma real, no como `unknown`.** La
   primera versión usaba `unknown` para esquivar la incompatibilidad entre las
   sobrecargas de los dos ORMs. Al medir el paquete instalado resultó que no
   hacía falta: las dos firmas son casi idénticas y difieren solo en el objeto
   de opciones, así que basta con declarar la unión aplicable
   (`SeedTransactionOptions`, con `isolationLevel` como `string`, el único
   supertipo común de los dos enums). Con eso:

   - no hay ningún cast en `runInTransaction()`;
   - la asignabilidad está **comprobada** contra clientes reales, no supuesta
     (`tests/types/`);
   - el `tx` del callback se tipa como `SeedClient`, y encaja porque los métodos
     que el `tx` real no tiene son justo los opcionales.
2. **El genérico de `SeedContext` no lleva restricción.** Exigir
   `TClient extends SeedClient` obligaría a hacer cast a quien pase un cliente
   cuyas sobrecargas no encajen. No aporta seguridad: el núcleo trabaja con
   `SeedClient` internamente, que sí está garantizado.
3. **`PrismaLike` se conserva como alias `@deprecated` de `SeedClient`.** Es una
   ampliación, no una ruptura: todo lo que satisfacía el tipo antiguo satisface
   el nuevo.

### 6.3 El registro en el ledger va dentro de la transacción del seeder

`ledger.record()` y `ledger.remove()` aceptan un cliente alternativo, que el runner
usa para pasarles el `tx`. Sin esto, un fallo entre "aplicar el seeder" y
"registrarlo" hace que la siguiente ejecución lo repita (B7).

Verificado end-to-end: un seeder que inserta una fila y luego lanza deja **0 filas
y 0 registros**.

### 6.4 Timeout de transacción de 5 minutos

Prisma usa **5 segundos** por defecto en transacciones interactivas. Un seeder con
unos miles de filas lo agota y falla por timeout, no por un error real. `PrismaLike.$transaction`
acepta opciones y el runner pasa `config.transactionTimeout`.

**Contrapartida**: una transacción larga mantiene bloqueos. Para sembrados masivos
o seeders que ejecutan DDL (que provoca commit implícito en MySQL), usar
`--no-transaction`.

### 6.5 El orden es por `batch DESC, id DESC`, no por fecha

La fase 0 demostró que dos seeders ejecutados en el mismo segundo comparten
`executedAt`, dejando `ORDER BY executedAt DESC` **indeterminado** (B6). El id
autoincremental es el único orden estricto disponible.

Por eso el DDL de SQLite usa `AUTOINCREMENT` y no solo `INTEGER PRIMARY KEY`:
impide reutilizar ids de filas borradas.

### 6.6 Un rollback sin archivo conserva el registro

Si el archivo del seeder ya no existe, se avisa y **no** se borra el registro del
ledger. Borrarlo perdería la información de que ese seeder llegó a aplicarse; así
se puede recrear el archivo y revertirlo después.

### 6.7 Validación de nombres por lista blanca

`/^[A-Za-z][A-Za-z0-9_-]*$/`. Cierra el escape de directorio (B10) *por
construcción*, sin depender de comparar rutas resueltas. `generate.ts` mantiene
además una segunda comprobación de ruta por si la validación se relaja algún día.

---

## 7. Registro de bugs de la v0.2.4

Los 14 detectados, con el estado tras la verificación real y dónde queda fijado.

| ID | Descripción | Estado | Corregido en | Test que lo fija |
|---|---|---|---|---|
| B1 | `CREATE TABLE` sin entrecomillar columnas → Postgres pliega a `seedname` | Confirmado | `dialect/postgres.ts` | `dialect.test.ts` + `ledger.test.ts` |
| B2 | `$queryRawUnsafe` para INSERT/DELETE | **Refutado** — funciona en Postgres. Se aplicó igual por el valor de retorno | `ledger.ts` | `ledger.test.ts` (`remove` informa si existía) |
| B3 | SQL exclusivo de Postgres | Confirmado. MySQL fallaba las 4 sentencias; SQLite corrompía la PK | `core/dialect/*` | `dialect.test.ts` (37) + `ledger.test.ts` × 3 motores |
| B4 | `PrismaClient` instanciado al importar | Confirmado | `core/prisma.ts` | `generate.test.ts`, `prisma.test.ts` |
| B5 | Falta `$disconnect()` | **Refutado** — no cuelga. Se añadió por higiene | `commands/*.ts` (`finally`) | `prisma.test.ts` |
| B6 | Orden de rollback por `executedAt` | Confirmado (empate demostrado) | `ledger.ts` | `ledger.test.ts` × 3 motores |
| B7 | Seeder y registro no atómicos | Confirmado | `runner.ts` | `ledger.test.ts` + verificación e2e |
| B8 | `new URL('file://' + ruta)` | Confirmado, **pero no por espacios** (§8.1) | `core/loader.ts` | `loader.test.ts` |
| B9 | `toLowerCase()` como accesor de modelo | Confirmado | `core/naming.ts` | `naming.test.ts`, `templates.test.ts` |
| B10 | Sin validación de nombre → escape de directorio | Confirmado | `core/resolver.ts` | `resolver.test.ts`, `generate.test.ts` |
| B11 | `catch` que traga errores → exit 0 | Confirmado | `core/errors.ts` + `cli.ts` | `cli.test.ts`, `generate.test.ts` |
| B12 | Un `PrismaClient` por seeder generado | Confirmado | `templates/seeder.ts` | `templates.test.ts` |
| B13 | `inquirer.prompt` es `undefined` bajo CJS | Confirmado — rompía `run` en todo proyecto nuevo | Sustituido por `@inquirer/prompts` | — |
| B14 | `error.code === 'P2010'` como "tabla ausente" | **Descubierto durante la verificación** | `dialect/*.isMissingTableError` | `dialect.test.ts`, `ledger.test.ts` |

**Dos de mis diagnósticos iniciales eran falsos** (B2 y B5). Quedan documentados
como refutados en vez de borrados: sirven de recordatorio de que la lectura de
código produce hipótesis, no hechos.

---

## 8. Trampas conocidas

Cosas que costaron tiempo y volverán a morder si se olvidan.

### 8.1 B8 no va de espacios

`new URL('file://' + ruta)` **funciona con espacios** — los normaliza a `%20` igual
que `pathToFileURL`. Lo que corrompe la ruta es:

| Carácter | Efecto |
|---|---|
| `#` | Inicia fragmento: `/tmp/con#x/s.mjs` se trunca a `/tmp/con` |
| `?` | Inicia query string: mismo truncamiento |
| `%` | Se interpreta como escape existente y se decodifica de más |

Mi descripción original decía "espacios o `#`". Era imprecisa.

### 8.2 Vitest no ejecuta `import()` dinámico como Node

Vitest enruta todo `import()` por su propio module runner, que **no resuelve URLs
`file://` con escapes de porcentaje**. Consecuencia: la carga end-to-end de un
seeder en una ruta con `#`/`?`/`%` **no se puede probar en la suite unitaria**.
Se intentó con `/* @vite-ignore */` y tampoco.

Está verificado a mano contra Node 20.20.2 real. La cobertura automatizada requiere
ejecutar el CLI como proceso (fase 7).

### 8.3 Postgres: `cached plan must not change result type`

Reutilizar una conexión a través de ciclos DROP/CREATE de la misma tabla provoca
`0A000`. **No afecta a producción** — se comprobó que tanto preparar la consulta
antes del `ALTER` como el flujo real del CLI funcionan. El disparador es el ciclo
repetido sobre una conexión viva, que solo ocurre en los tests. El test de
migración del ledger usa un cliente aislado por eso.

### 8.4 SQLite no tiene códigos de error granulares

Todo llega como código `1`. `isMissingTableError` tiene que hacer coincidencia
sobre el texto (`/no such table/i`). Es frágil por naturaleza; es lo único que
expone el motor. Si SQLite cambia el texto, ese test cae — y debe caer.

### 8.5 `exactOptionalPropertyTypes` está activo

`{ x: undefined }` **no** es asignable a `{ x?: string }`. Por eso:
- `UserSeederConfig` es un mapped type que admite `undefined` explícito, no un `Partial`.
- `stripUndefined` declara `StripUndefined<T>` para que el tipo refleje lo que
  garantiza en runtime.
- Al construir objetos opcionales se usa `...(cond ? { k: v } : {})`.

### 8.6 El `define` de Vite no llega a los tests

Un `__VERSION__` inyectado por tsup existe en el bundle pero **no** en Vitest, que
transforma en modo SSR. Por eso `src/version.ts` importa `package.json` de verdad
en lugar de usar una global inyectada.

### 8.7 Dos `generate` en el mismo segundo

El prefijo tiene resolución de segundos. `generate user` dos veces en el mismo
segundo produce el mismo nombre de archivo → `CliError` "ya existe". Es correcto
pero puede sorprender en scripts. Si molesta, la solución es añadir sufijo o subir
a milisegundos (rompería el orden respecto de seeders antiguos).

### 8.8 TypeScript 7 no es adoptable todavía

`typescript@7.0.2` es el `latest` del registro, pero `typescript-eslint@8.67.0`
—el último que hay— declara `typescript >=4.8.4 <6.1.0` y no existe una v9. Como
este proyecto se apoya en `recommendedTypeChecked` (es lo que destapó que
`PrismaClient` degradaba a `any`, §6.2), subir a TS 7 significaría perder el lint
con tipos. Se queda en **TypeScript 6.0.3**, lo más nuevo que ambos admiten.

### 8.9 tsup inyecta `baseUrl`, que TypeScript 6 deprecó

`tsup/dist/rollup.js` hace `baseUrl: compilerOptions.baseUrl || "."` a mano, así
que la emisión de tipos siempre lo recibe y falla con `TS5101`. No hay tsconfig
que lo evite. Por eso existe `tsconfig.build.json`, que solo para el build activa
`"ignoreDeprecations": "6.0"` y anula el `paths` de los tests. El typecheck del
proyecto **no** silencia deprecaciones. Quitar el flag cuando tsup deje de
inyectarlo.

### 8.10 El suelo de Node lo marcan las dependencias de runtime

`engines` no es decorativo. Medido en Node 18.20.8 real: el CLI ni arranca porque
`@inquirer/prompts@8` importa `styleText` de `node:util`, que apareció en Node
20.12. Y `commander@15` declara `>=22.12.0`, que es el suelo efectivo. Al subir
cualquiera de las dos, revisar `engines`, la matriz de CI y el `NODE_VERSION` del
Dockerfile a la vez.

### 8.11 `legacy/` ya no existe

Durante el port, `legacy/` guardaba la v0.2.4 ejecutable con su propio
`{"type": "commonjs"}` (la raíz es `type: module`). Se borró al cerrar la fase 5.
Si hace falta volver a mirarla, está en el historial de git.

---

## 9. Limitaciones y deuda conocida

| Asunto | Detalle |
|---|---|
| **SQL Server sin verificar** | El dialecto está implementado y sus tests unitarios pasan, pero **nunca se ha ejecutado contra un servidor real**. Que ese SQL funcione es una hipótesis. No hay contenedor en `docker-compose.yml`. |
| **Prisma 7: solo por inyección** | La construcción automática (`new PrismaClient()`) sigue sin funcionar en 7, que exige un *driver adapter*. Con `client` en `seeder.config` funciona, porque la librería deja de construir nada. Ver §9.1. |
| **El test contra un ORM real necesita un proyecto externo** | Verificado contra ZenStack 3.9.1 + Postgres 17: tipos, API programática y CLI. Pero ese ORM no puede instalarse en este repositorio, así que la suite normal **salta** ese test y hay que lanzarlo aparte con `tests/integration/real-client/run.sh`. En CI no corre. |
| **Un solo ORM alternativo verificado** | Sobre Postgres. Los demás motores y el caso de un ORM que aplique políticas al SQL crudo están implementados y cubiertos por el doble, no por un paquete real. |
| **ORMs con políticas y SQL crudo** | Un ORM que aplique control de acceso a nivel de fila puede rechazar el SQL crudo que usa el ledger. Hay que inyectar el cliente sin políticas — que es lo correcto para un seed, que es trabajo de sistema. Se detecta y se avisa, pero no se puede resolver desde la librería. |
| **`tsx` y los alias de `tsconfig`** | Con seeders o config en TypeScript hay que lanzar el CLI con el **binario** `tsx`, no con `node --import tsx/esm`: el segundo no resuelve los `paths` del tsconfig. Ver §5.6. |
| **MongoDB no soportado** | No tiene transacciones al estilo relacional ni autoincrementales. Requeriría un camino aparte. |
| `order` y `dependencies` | Se leen y se tipan, pero el runner **no los aplica**. El orden es solo por timestamp. |
| Sin bloqueo de concurrencia | Dos `run` simultáneos pueden ejecutar el mismo seeder dos veces. Previsto: advisory lock. |
| Cobertura e2e del loader | Ver §8.2. |
| Seeders `.ts` | El loader los detecta y da un mensaje accionable, pero requieren `tsx` y **no se ha probado el camino completo**. |
| `version` en `package.json` | Sigue en `0.2.4`. Subir a `1.0.0` al publicar. |
| `LICENSE` ausente | `package.json` lo declara en `files` pero el archivo no existe, así que el tarball sale sin licencia pese a decir `"license": "MIT"`. Añadirlo antes de publicar. |
| README | Sigue documentando la v0.2.4. Desactualizado en todo lo importante. |

### 9.1 Qué haría falta para soportar Prisma 7

Cambios que introduce Prisma 7 y a qué afectan:

| Cambio de Prisma 7 | Impacto |
|---|---|
| `url` sale del `datasource` | `core/schema.ts` sigue funcionando (lee `provider`, que permanece), pero ya no se puede deducir la conexión del schema. |
| `PrismaClient` exige un *driver adapter* | `core/prisma.ts` tendría que resolver e instanciar el adapter del motor (`@prisma/adapter-pg`, `@prisma/adapter-mariadb`, `@prisma/adapter-better-sqlite3`) en vez de `new PrismaClient()`. |
| `prisma.config.ts` pasa a ser la fuente de configuración | Habría que leerlo para obtener la URL, o exigir que el usuario pase el cliente ya construido. |
| `datasourceUrl` en el constructor | Lo usa `tests/integration/helpers/clients.ts`; hay que revisar si sigue existiendo. |

**Resuelto por inyección.** La alternativa que este documento planteaba —que el
usuario inyecte el cliente en vez de que lo construya la librería— es lo que se
implementó (§5.6). Con `client` en `seeder.config.*`, la librería no resuelve
adapters ni lee URLs, así que es indiferente a la versión de Prisma:

```ts
// seeder.config.ts, Prisma 7
import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { defineConfig } from 'prisma-seed';

export default defineConfig({
  client: () => new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) }),
});
```

Lo que sigue sin funcionar es el camino **automático** en Prisma 7, y no se va a
arreglar: adivinar el adapter correcto es exactamente el tipo de suposición que
provocó B3. `peerDependencies` se mantiene en `>=5 <7` para el camino automático.

---

## 10. Probar el paquete sin publicarlo

El entorno tiene un banco de pruebas en `.sandbox/` (ignorado por git, con su
`node_modules` en un volumen). Instala **el tarball real**, así que verifica lo
mismo que verá un usuario: el contenido de `files`, la ruta de `bin` y el mapa de
`exports`.

Todo el flujo está automatizado en el wrapper `./sandbox`:

```bash
./sandbox all         # empaquetar + instalar + CLI + API + tipos
./sandbox install     # solo empaquetar, instalar el tarball y aplicar el schema
./sandbox cli         # generate / run / run / rollback
./sandbox api         # API programática (ESM), require (CJS) y tipos publicados
./sandbox reset       # vaciar la base del banco
./sandbox shell       # bash dentro del banco, para trastear a mano
```

Qué comprueba `./sandbox all`, y que ninguna otra prueba cubre:

| | |
|---|---|
| Empaquetado | El `.tgz` real: `files`, `bin`, `exports` |
| CLI instalado | `npx prisma-seed` resuelto desde `node_modules/.bin` |
| API programática | `runSeeders(prisma)` desde ESM, y que **no cierra** el cliente prestado |
| Interoperabilidad | `require('prisma-seed')` desde CommonJS |
| Tipos publicados | `tsc` contra `dist/index.d.ts` con un `PrismaClient` generado real |

Los archivos de prueba (`seed.mjs`, `seed.cjs`, `tipos.ts`) se **regeneran en cada
`install`**: `.sandbox/` no está versionado, así que lo que se ejercita
corresponde siempre a la versión actual del repositorio.

A mano, si hace falta depurar algo puntual:

```bash
./dx npm pack
./dx shell
  cd /app/.sandbox
  npm install /app/prisma-seed-<version>.tgz "@prisma/client@^6" "prisma@^6"
  export DATABASE_URL="$POSTGRES_URL"
  npx prisma db push --skip-generate && npx prisma generate
  npx prisma-seed run
```

Cada `./dx` crea un contenedor nuevo: lo que escribas en `/tmp` desaparece al
terminar el comando; `.sandbox/` está bajo `/app` y persiste.

Alternativas y por qué no se usan aquí:

| Método | Valoración |
|---|---|
| `npm pack` + instalar el tarball | **El de mayor fidelidad.** Es lo único que detecta un `files` incompleto o un `bin` mal apuntado. |
| `npm link` | Cómodo pero engañoso: enlaza el directorio entero, así que funciona aunque `files` esté mal. |
| `"lib": "file:../ruta"` | Igual que `link`: copia o enlaza sin respetar `files`. |

> **Bug encontrado con este método**: el `npm pack` inicial produjo un tarball con
> **solo `README.md` y `package.json`**, sin `dist/`. La causa era que el script
> se llamaba `prepublishOnly`, que npm **no** ejecuta en `npm pack` — solo en
> `publish`. Se renombró a `prepack`, que cubre ambos. Sin esta prueba, el fallo
> habría aparecido en el primer `npm publish` con `dist/` sin compilar.

---

## 11. Estrategia de tests

```
tests/
├── unit/          256 tests · sin red ni base de datos · milisegundos
│   ├── api.test.ts (27)       runSeeders/rollbackSeeders con cliente inyectado
│   ├── cli.test.ts (8)        superficie de comandos, códigos de salida
│   ├── client.test.ts (23)    capacidades, transacción, ciclo de vida, resolución
│   ├── config.test.ts (21)    precedencia, validación, autodetección de schema
│   ├── dialect.test.ts (49)   SQL por motor + errores de Prisma y de ZenStack
│   ├── generate.test.ts (24)  ficheros, variantes, B10, tipado del cliente
│   ├── loader.test.ts (15)    interop ESM/CJS, B8
│   ├── logger.test.ts (8)     niveles
│   ├── naming.test.ts (13)    B9, timestamps
│   ├── project.test.ts (16)   raíz del proyecto, descubrimiento de schema
│   ├── resolver.test.ts (21)  descubrimiento, orden, ambigüedad
│   ├── schema.test.ts (13)    provider en .prisma y en .zmodel
│   ├── templates.test.ts (16) plantillas generadas
│   └── helpers/
│       ├── fake-clients.ts    tres dobles: Prisma, otra implementación, y el mínimo
│       └── memory-client.ts   ledger en memoria que habla el SQL del dialecto
├── integration/   82 tests · bases reales
│   ├── prisma.test.ts (7)     resolución automática del cliente, B4
│   ├── ledger.test.ts (39)    13 tests × 3 motores
│   ├── injection.test.ts (36) 12 tests × 3 motores × 2 implementaciones
│   ├── helpers/
│   │   └── contract-client.ts segunda implementación del contrato, no-Prisma
│   └── real-client/           9 tests · ORM REAL EXTERNO · fuera de la suite
│       ├── real-client.integration.test.ts
│       ├── seeders/           2 seeders, solo SQL crudo: valen en cualquier proyecto
│       ├── seeders-fallo/     1 seeder que falla, para la atomicidad
│       ├── run.sh             monta el entorno, comprueba tipos, ejecuta y revierte
│       └── run-cli.sh         lo mismo para el binario
└── types/         comprobaciones de TIPOS · fuera de `npm run typecheck`
    ├── prisma-client.test-d.ts  contra el PrismaClient generado del fixture
    ├── real-client.test-d.ts    contra el cliente de un proyecto externo
    └── run.sh                   lanza la mitad de Prisma
```

**Por qué `tests/types/` está fuera de `npm run typecheck`.** Porque en la raíz de
este repositorio `@prisma/client` no tiene cliente generado y `PrismaClient`
degrada a `any` (§6.2). Comprobar la asignabilidad ahí daría verde sin probar
nada — lo detectó el propio `Assert<...>` del archivo al escribirlo. Cada mitad
se compila contra un cliente de verdad: el generado del fixture para Prisma, y el
del proyecto consumidor para ZenStack.

**Dos niveles para el segundo cliente, y hacen falta los dos.**

1. **El doble** (`helpers/contract-client.ts`) corre en la suite normal, en los
   tres motores. No es Prisma: sin `$extends` ni `$on`, con `$qb`/`$schema`, y con
   errores sin `meta` (`reason` + `dbErrorCode`/`dbErrorMessage`). Fija el
   contrato y no depende de nada externo.
2. **Un ORM real externo** (`real-client/run.sh`). Es el que descubrió que la
   documentación de un ORM puede no coincidir con su `.d.ts`, que un cliente
   ignora en silencio las opciones que no entiende —lo que permitió borrar la
   última rama por implementación— y que `tsx` no resuelve los alias del
   tsconfig. El doble, por definición, no podía encontrar ninguna de las tres.

**Principios que conviene mantener:**

1. Cada bug corregido tiene un test que lo fija, con el ID del bug en el comentario.
   Si alguien "simplifica" `quote()` a comillas dobles, `dialect.test.ts` cae.
2. Los tests de integración se ejecutan **idénticos sobre los tres motores** vía
   `describe.each(ENGINES)`. Añadir un motor no requiere escribir tests nuevos.
3. Los tests de integración no se paralelizan (`poolOptions.threads.singleThread`):
   comparten esquema.
4. Antes de dar por buena una corrección, **ejecutar el CLI compilado** contra una
   base real. Compilar y pasar tests no es lo mismo que funcionar.
5. Los dos caminos de cliente se prueban con **el mismo cuerpo de test**
   (`describe.each(FLAVORS)`). Si uno necesita un caso especial, es señal de que
   se ha filtrado un acoplamiento al runner.

---

## 12. Compatibilidad al publicar la 1.0.0

**Cambios que rompen:**

1. **`rollback` sin argumentos revierte solo el último batch**, no todo. El
   comportamiento de la v0.2.4 está en `--all`. Es el cambio de mayor impacto.
2. **El ledger gana la columna `batch`.** Migración automática y verificada en los
   tres motores: se detecta la tabla sin la columna, se hace `ALTER TABLE ADD
   COLUMN batch DEFAULT 1` y el histórico queda en el batch 1.
3. **Desaparece `main` de librería** en favor de `exports`. Solo afecta a quien
   importara `cli.js`, que nadie debería hacer.

**Se mantiene:** los seeders `.js` existentes con `main()`/`down()` funcionan sin
tocarlos, creen o no su propio `PrismaClient`.

### 12.1 Cambios de la inyección de cliente

Ninguno rompe a un usuario de Prisma tradicional: sin configurar nada, el
comportamiento es el mismo.

| Qué cambia | Antes | Ahora | Por qué |
|---|---|---|---|
| Tipo del cliente | `PrismaLike`, con `$connect`/`$disconnect`/`$transaction` obligatorios | `SeedClient`: solo el SQL crudo es obligatorio | Un `ZenStackClient` no es asignable a la firma concreta de `$transaction` de Prisma. `PrismaLike` sigue exportado como alias `@deprecated`: es una ampliación, no una ruptura |
| Contexto del seeder | `{ prisma, logger, name }` | `{ prisma, client, logger, name }` | `client` es la misma referencia con nombre neutral. Nada que se apoye en `prisma` deja de funcionar |
| Genérico de `SeedContext` | `<TClient extends PrismaLike>` | `<TClient = SeedClient>` | Quitar la restricción evita que quien inyecte un cliente exótico tenga que hacer cast |
| `schemaPath` | siempre `prisma/schema.prisma` | autodetectado si nadie lo declara | El valor por defecto solo se aplica cuando no hay ningún candidato, así que ningún proyecto Prisma cambia |
| Raíz del proyecto | `process.cwd()` | primera carpeta hacia arriba con `package.json`, `prisma/` o `zenstack/` | `pnpm seed` desde un subdirectorio ya no falla. Si no hay ninguna marca se usa el `cwd`, así que no puede escaparse |
| API pública | solo tipos y `defineConfig` | además `runSeeders` / `rollbackSeeders` | Es una adición |
| Plantilla `generate --ts` | siempre `PrismaClient` | según `clientType` o el schema (§5.7) | Solo cambia en proyectos con schema `.zmodel`, donde antes generaba código que no compilaba |
| Tipo de `$transaction` en `SeedClient` | `unknown` (versión preliminar) | firma real con `SeedTransactionOptions` | Comprobado asignable desde un `PrismaClient` y un `ClientContract` reales (§6.2) |

**Antes de publicar**: subir la versión, reescribir el README, y considerar
`1.0.0-beta.0` bajo el tag `next`.

---

## 13. Próximos pasos

### Fase 5 — `status`, `fresh`, `refresh`

`fresh` es el equivalente a `php artisan migrate:fresh --seed` que motivó el
rediseño. **`prisma migrate reset --force --skip-seed` ya hace el trabajo pesado**
y es agnóstico al motor, así que no hace falta SQL por dialecto para el camino
principal:

```
fresh:
  1. NODE_ENV=production → exigir --force
  2. mostrar host y base de destino, pedir confirmación (salvo --force)
  3. prisma migrate reset --force --skip-seed
  4. ledger.ensureTable()
  5. si --seed → runSeeders()
```

La variante `fresh --truncate` (vaciar sin recrear el esquema) sí necesita SQL por
motor: **`Dialect.truncateAll()` ya está implementado y con tests en los cuatro
dialectos**, listo para usarse. La lista de tablas debe salir del DMMF de Prisma,
no del catálogo del motor, para respetar los `@@map` y no tocar tablas ajenas.

### Fase 6 — generación desde el schema

`generate --model User` leyendo `schema.prisma` con `@prisma/internals` (`getDMMF`)
para emitir un `create` con los campos reales. Hoy la plantilla deja un `create: {}`
vacío con un TODO. Incluye integración opcional con `@faker-js/faker`.

### Fase 7 — CI e2e y documentación

Tests que ejecuten el CLI como proceso real (cierra §8.2), el job de integración de
GitHub Actions ya está escrito en `.github/workflows/ci.yml`, README reescrito y
guía de migración 0.2 → 1.0.

### Sin asignar a fase

- Verificar SQL Server contra un servidor real, o retirarlo de la lista de soportados.
- Aplicar `order` y `dependencies` en el runner (ordenación topológica).
- Bloqueo de concurrencia para `run`.
