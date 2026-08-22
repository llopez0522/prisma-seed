# prisma-seed

Versioned, reversible database seeding for Prisma projects — with Laravel-style
commands.

Prisma gives you one `prisma/seed.ts` that reruns from scratch every time.
`prisma-seed` gives you **migration-like seeders**: each file runs once, is
recorded in a ledger table, is grouped into a batch, and can be rolled back.

```bash
npm install --save-dev prisma-seed
```

```bash
npx prisma-seed generate User   # scaffold prisma/seeders/<timestamp>_User.[ts|js]
npx prisma-seed run             # apply what's pending
npx prisma-seed status          # see what's applied and what isn't
npx prisma-seed rollback        # revert the last batch
```

The client is **injected**, never constructed by the library. That is what makes
it work with `PrismaClient` and, equally, with any other client that satisfies a
small contract — including the `ZenStackClient` from ZenStack v3.

---

## Features

- **Run-once semantics.** Every seeder is recorded in a ledger table
  (`SeedExecution` by default). Running twice does nothing the second time.
- **Batches.** Each `run` groups its seeders into a numbered batch, so
  `rollback` can revert exactly the last one.
- **Reversible.** Each seeder exports `down()`; `rollback`, `refresh` and
  `rollback --all` use it.
- **Atomic.** Each seeder and its ledger record run inside one transaction. A
  failure halfway through leaves neither the data nor the record.
- **Client injection.** `runSeeders(client)` — the library never calls
  `new PrismaClient()` when you give it a client, and never disconnects one it
  did not create.
- **Four SQL dialects.** PostgreSQL, MySQL, SQLite and SQL Server, each with its
  own DDL, identifier quoting and placeholder syntax.
- **CLI and programmatic API.** Six commands, plus `runSeeders` /
  `rollbackSeeders` for a `seed.ts` of your own.
- **Scaffolding.** `generate` writes a typed seeder and picks TypeScript,
  ESM or CommonJS based on your project.
- **`fresh`.** Truncates every table and resets autoincrement counters — the
  reset you want between test runs.
- **Automatic ledger migration.** A ledger table from an older layout gains its
  `batch` column on first run, with the existing history placed in batch 1.

## Requirements

| | |
|---|---|
| **Node.js** | `>= 22.12.0`. Enforced by `engines`. The floor comes from `commander@15`, a runtime dependency; on Node 18 the CLI does not start at all. |
| **A database client** | Either `@prisma/client`, or any object satisfying the [`SeedClient`](#seedclient) contract. |
| **Databases** | PostgreSQL, MySQL, SQLite or SQL Server. MongoDB is not supported. |
| **TypeScript** | Optional. The package ships its own type declarations; JavaScript projects work without any TypeScript setup. |

`@prisma/client` is an **optional** peer dependency (`>=5 <7`). Install it if you
want the CLI to build the client for you; a project that injects its own client
does not need it, and npm will not pull it in.

Running seeders written in TypeScript additionally needs a loader — see
[TypeScript](#typescript).

## Installation

```bash
npm install --save-dev prisma-seed
```

Nothing else is required for a standard Prisma project: the CLI resolves
`@prisma/client` from your project and builds the client itself.

## Commands

```bash
npx prisma-seed generate Tarifas            # create the seeder file
npx prisma-seed run                         # apply what's pending
npx prisma-seed run --dry-run               # show what would run, touch nothing
npx prisma-seed run Roles                   # one seeder, short name
npx prisma-seed run 20260822102358_Roles    # one seeder, full name
npx prisma-seed status                      # applied / pending
npx prisma-seed rollback                    # revert the last batch
npx prisma-seed fresh --seed                # empty everything and re-seed
```

Variants:

```bash
npx prisma-seed fresh --seed --force        # no prompt (CI, scripts)
npx prisma-seed fresh --seed --dry-run      # see what it would do, change nothing
npx prisma-seed refresh                     # surgical: only redo your seeders
```

### Reference

| Command | What it does |
|---|---|
| `generate <name>` | Scaffolds a new seeder in `seedersDir`. Does not touch the database. |
| `run [name]` | Applies every pending seeder, or only the one named. Groups them into a new batch. |
| `status` | Lists every seeder as applied, pending, or recorded-but-missing. **The only command that writes nothing** — not even the ledger table. |
| `rollback [name]` | Reverts the last batch by calling each seeder's `down()`. With a name, reverts just that one. |
| `refresh` | Reverts everything via `down()`, then re-applies it all. Leaves data the seeders never touched alone. |
| `fresh` | Truncates **every table** and resets autoincrement counters. With `--seed`, re-applies the seeders afterwards. |

### Options

| Command | Option | What it does |
|---|---|---|
| `generate` | `--model <model>` | Target model, when it differs from the seeder name |
| | `--ts` | Force TypeScript, even if the project does not look like it |
| | `--js` | Force JavaScript, even if the project is TypeScript |
| `run` | `--class <name>` | Alias of the positional name, for familiarity with Laravel |
| | `--step <n>` | Apply only the next N pending seeders |
| | `--dry-run` | List what would run, without touching the database |
| | `--force` | Allow running with `NODE_ENV=production` |
| `rollback` | `--step <n>` | Revert the last N seeders |
| | `--all` | Revert the whole history, not just the last batch |
| | `--dry-run` | List what would be reverted |
| | `--force` | Allow running with `NODE_ENV=production` |
| `refresh` | `--dry-run` | List what would be reverted and re-applied |
| | `--force` | Allow running with `NODE_ENV=production` |
| `fresh` | `--seed` | Apply the seeders after emptying |
| | `--dry-run` | List the tables it would empty |
| | `--force` | Skip the confirmation prompt, and allow `NODE_ENV=production` |

Global options, valid before any command:

| Option | What it does |
|---|---|
| `-v, --version` | Print the installed version |
| `-h, --help` | Help for the program or for a command |
| `-q, --quiet` | Only show errors |
| `--verbose` | Show every step: resolved root, engine, schema, client capabilities |
| `--cwd <path>` | Project root. By default it is found by walking up from the current directory |
| `--no-transaction` | Do not wrap each seeder in a transaction |

**Exit codes:** `0` success · `1` a seeder or the operation failed · `2` usage
error (bad argument, ambiguous name) · `3` the client could not be resolved or
connected.

### As npm scripts

```json
{
  "scripts": {
    "seed": "prisma-seed run",
    "seed:new": "prisma-seed generate",
    "seed:status": "prisma-seed status",
    "seed:rollback": "prisma-seed rollback",
    "seed:refresh": "prisma-seed refresh",
    "seed:fresh": "prisma-seed fresh --seed"
  }
}
```

Then `npm run seed`, and `--` to pass arguments through npm:

```bash
npm run seed:new -- Tarifas
npm run seed -- --dry-run
npm run seed -- Roles
npm run seed:fresh -- --force
```

## PrismaClient

The default path. In a project with `prisma/schema.prisma` and a generated
client, there is nothing to configure.

### CLI

```bash
npx prisma-seed generate User
npx prisma-seed run
```

The CLI finds your project root, reads the `provider` from `prisma/schema.prisma`,
constructs a `PrismaClient`, creates the ledger table if needed, applies pending
seeders, and disconnects.

### Programmatic

```ts
import { PrismaClient } from '@prisma/client';
import { runSeeders } from 'prisma-seed';

const prisma = new PrismaClient();

const report = await runSeeders(prisma);
console.log(report); // { executed: [...], skipped: [...], batch: 1, dryRun: false }

await prisma.$disconnect(); // you opened it, you close it
```

`runSeeders` and `rollbackSeeders` **never disconnect a client you passed in**.
The CLI does close the one it creates, because there it owns the process.

## ZenStack v3

ZenStack v3 replaced Prisma's ORM with its own, so a ZenStack project may not
have `@prisma/client` at all. `prisma-seed` supports it because it depends on a
contract rather than on an ORM: `ZenStackClient` exposes `$queryRawUnsafe`,
`$executeRawUnsafe`, `$transaction`, `$connect` and `$disconnect` with the same
shapes the library needs.

> **Support status.** ZenStack v3 is supported. Compatibility has been verified
> against `@zenstackhq/orm@3.9.1` on PostgreSQL, in a Next.js 16 application.
> Next.js is **not** a requirement of `prisma-seed` — it is simply the
> application the verification was performed in. Other frameworks and other
> databases are expected to work but have not been verified.

### Providing the client

ZenStack's client is built with a Kysely dialect and a driver, so the library
cannot construct it for you. Declare it once:

```js
// seeder.config.mjs
export default {
  // The application's own client. Returned lazily so the pool is not opened
  // just to read the configuration.
  client: async () => (await import('./lib/db.ts')).db,

  // ZenStack projects usually have no `prisma/` directory.
  seedersDir: 'zenstack/seeders',
};
```

Or inject it directly:

```ts
import { runSeeders } from 'prisma-seed';
import { db } from './lib/db';

await runSeeders(db);
```

The engine is read from the `datasource` block, which ZModel declares the same
way Prisma does. `zenstack/schema.zmodel` is one of the locations
[searched automatically](#schema-discovery), including the single-quoted
`provider = 'postgresql'` form that ZModel examples use.

### Two things to know

**Use the client without access policies.** The ledger is maintained with raw
SQL, and ZenStack's policy plugin rejects raw SQL by default. Inject the plain
client — a seed is system work, not an action on behalf of a user:

```ts
// lib/db.ts
export const db = new ZenStackClient(schema, { dialect });  // ← inject this one
export const authDb = db.$use(new PolicyPlugin());          // ← not this one
```

If you inject a policy-enforcing client, the error message says so.

**`transactionTimeout` does not apply.** ZenStack's `$transaction` accepts
options, but only `{ isolationLevel }`. The library always sends the same options
object and each client applies what it understands, so the setting is simply
ignored there.

## Usage

### 1. Create a seeder

```bash
npx prisma-seed generate User
```

This writes `prisma/seeders/20260101120000_User.ts` — or `.js`, depending on
[what it detects](#what-generate-writes). The timestamp prefix is what gives the
run order.

### 2. Fill it in

```ts
import type { PrismaClient } from '@prisma/client';
import type { SeedContext } from 'prisma-seed';

type Ctx = SeedContext<PrismaClient>;

export async function main({ prisma, logger }: Ctx) {
  await prisma.user.create({
    data: { email: 'ada@example.com', name: 'Ada Lovelace' },
  });
  logger.info('Ada created');
}

export async function down({ prisma }: Ctx) {
  await prisma.user.deleteMany({ where: { email: 'ada@example.com' } });
}
```

`main` is required. `down` is optional, but without it `rollback` will skip the
seeder and say so.

Seeders **do not need to be idempotent**: the ledger guarantees a single
execution. `create` is fine; `upsert` is not required.

Never construct a client inside a seeder — that is one connection pool per file.
It arrives in the context.

### 3. Run

```bash
npx prisma-seed run
npx prisma-seed status
```

```
✓ ejecutado     1  20260101120000_User
· pendiente        20260101130000_Post

2 en disco · 1 ejecutados · 1 pendientes
```

> CLI output and error messages are currently in Spanish.

### 4. Undo

```bash
npx prisma-seed rollback          # the last batch
npx prisma-seed rollback User     # one seeder
npx prisma-seed rollback --all    # everything
```

### Execution order

Seeders run in **filename order**, computed as:

1. Files with a `YYYYMMDDHHmmss_` prefix first, oldest first.
2. Files without a prefix after them, alphabetically.
3. Ties broken alphabetically.

There is no dependency resolution between seeders. If `Post` needs `User`, give
`User` an earlier timestamp.

### Naming a single seeder

`run`, `rollback` and `--class` accept a full name or a shorthand. Resolution is
tried in this order: exact match, case-insensitive match, match ignoring the
timestamp prefix, then partial match. An ambiguous name is an error listing the
candidates, never a silent guess.

```bash
npx prisma-seed run 20260101120000_User
npx prisma-seed run User
npx prisma-seed run user
```

An already-applied seeder is not re-run. To repeat one:

```bash
npx prisma-seed rollback User && npx prisma-seed run User
```

## API

The command line is documented in [Commands](#commands). This section covers the
programmatic API — what `import ... from 'prisma-seed'` gives you.

### `runSeeders(client, options?)`

```ts
function runSeeders(client: SeedClient, options?: RunSeedersOptions): Promise<RunReport>;

interface RunSeedersOptions {
  cwd?: string;               // project root; found by walking up if omitted
  config?: UserSeederConfig;  // overrides for any configuration key
  logger?: Logger;            // defaults to the library's console logger
  ensureLedgerTable?: boolean; // default true
  only?: string;              // run just this seeder
  step?: number;              // run at most N pending seeders
  dryRun?: boolean;           // report without touching the database
}

interface RunReport {
  executed: string[];
  skipped: { name: string; reason: string }[];
  batch: number;
  dryRun: boolean;
}
```

### `rollbackSeeders(client, options?)`

```ts
function rollbackSeeders(
  client: SeedClient,
  options?: RollbackSeedersOptions
): Promise<RollbackReport>;

interface RollbackSeedersOptions {
  cwd?: string;
  config?: UserSeederConfig;
  logger?: Logger;
  ensureLedgerTable?: boolean;
  only?: string;    // revert just this one
  step?: number;    // revert the last N
  all?: boolean;    // revert the whole history
  dryRun?: boolean;
}

interface RollbackReport {
  reverted: string[];
  skipped: { name: string; reason: string }[];
  dryRun: boolean;
}
```

### `defineConfig(config)`

Identity helper that types a `seeder.config.*` file. Returns its argument
unchanged.

### `SeedClient`

The contract. Only the two raw-SQL methods are required — they are what
maintains the ledger:

```ts
interface RawSqlClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

interface SeedClient extends RawSqlClient {
  $connect?: () => Promise<void>;
  $disconnect?: () => Promise<void>;
  $transaction?<R>(
    fn: (tx: SeedClient) => Promise<R>,
    options?: SeedTransactionOptions
  ): Promise<R>;
}

interface SeedTransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: string;
}
```

The three optional members are optional because they genuinely can be missing:
the client both Prisma and ZenStack hand you *inside* a transaction has none of
them. A client without `$transaction` still works with `transactional: false`.

### `SeedContext<TClient>`

What a seeder receives:

```ts
interface SeedContext<TClient = SeedClient> {
  prisma: TClient;  // the injected client
  client: TClient;  // the same object, neutrally named
  logger: Logger;
  name: string;     // the seeder's filename without extension
}
```

### Low-level helpers

Not needed for normal use:

| Export | Purpose |
|---|---|
| `assertSeedClient(value, origin)` | Throws unless `value` satisfies the contract. |
| `capabilitiesOf(client)` | `{ transactions, connect, disconnect }` — what a client can do. |
| `supportsTransactions(client)` | Shorthand for the above. |
| `createLogger(options)`, `silentLogger` | The library's logger, and a no-op one. |

### Exported types

`SeedClient`, `RawSqlClient`, `SeedTransactionOptions`, `SeedClientCapabilities`,
`SeedClientFactory`, `SeedClientSource`, `SeedContext`, `SeederConfig`,
`UserSeederConfig`, `SeederModule`, `Provider`, `Logger`, `LogLevel`,
`LoggerOptions`, `DiscoveredSeeder`, `SeedExecutionRecord`, `RunReport`,
`RollbackReport`, `RunSeedersOptions`, `RollbackSeedersOptions`,
`SeedApiOptions`. `PrismaLike` is a deprecated alias of `SeedClient`.

## Configuration

Optional. Read from `seeder.config.ts` (also `.mts`, `.js`, `.mjs`, `.cjs`), or
from a `prismaSeeder` key in `package.json`.

```ts
import { defineConfig } from 'prisma-seed';

export default defineConfig({
  seedersDir: 'prisma/seeders',
  ledgerTable: 'SeedExecution',
  transactional: true,
});
```

| Key | Default | What it does |
|---|---|---|
| `seedersDir` | `prisma/seeders` | Where seeders live, relative to the project root |
| `schemaPath` | auto-detected | File the `provider` is read from |
| `provider` | from the schema | `postgresql` \| `mysql` \| `sqlite` \| `sqlserver`. Setting it skips reading the schema entirely |
| `ledgerTable` | `SeedExecution` | Validated as a SQL identifier |
| `transactional` | `true` | Wrap each seeder plus its ledger write in one transaction |
| `transactionTimeout` | `300000` | Milliseconds. Prisma's own default is 5 s, far too little for seeding. Clients that have no such option ignore it |
| `client` | — | A client, or a (possibly async) factory returning one. The injection point |
| `closeClient` | `true` | CLI only. `false` stops it from disconnecting a client you provided |
| `seederLanguage` | auto-detected | `ts` \| `esm` \| `cjs` for generated files |
| `clientType` | Prisma | `{ import, type }` — how to type the client in generated TypeScript seeders |
| `freshExclude` | `[]` | Extra tables `fresh` must not empty |

Precedence, lowest to highest: defaults → `package.json` → `seeder.config.*` →
CLI flags.

### Project and schema discovery

The **project root** is the nearest ancestor directory containing
`package.json`, `prisma/` or `zenstack/`. That is why the CLI works from any
subdirectory. If no marker is found, the current directory is used.

<a id="schema-discovery"></a>The **schema** is looked for in this order, and only
the `provider` is read from it:

1. `prisma.schema` or `zenstack.schema` in `package.json`
2. `prisma/schema.prisma`
3. `zenstack/schema.zmodel`
4. `schema.zmodel`
5. `prisma/schema.zmodel`

Both `provider = "postgresql"` and `provider = 'postgresql'` are accepted.

### The ledger table

Created automatically on first run:

| Column | |
|---|---|
| `id` | autoincrement primary key |
| `seedName` | unique; the filename without extension |
| `batch` | which `run` applied it |
| `executedAt` | timestamp |

You do not have to declare it in your schema. Declaring it is still worth doing,
because a schema-push command would otherwise see an extra table it wants to
drop. Use `@@map` to state the table name explicitly:

```prisma
model SeedExecution {
  id         Int      @id @default(autoincrement())
  seedName   String   @unique
  batch      Int      @default(1)
  executedAt DateTime @default(now())

  @@map("SeedExecution")
}
```

**The table name is yours to choose; the column names are not.** `@@map` must
agree with `ledgerTable`, so in a project that maps everything to snake_case:

```prisma
model SeedExecution {
  id         Int      @id @default(autoincrement())
  seedName   String   @unique
  batch      Int      @default(1)
  executedAt DateTime @default(now())

  @@map("seed_executions")
}
```

```ts
export default defineConfig({ ledgerTable: 'seed_executions' });
```

Do **not** put `@map` on the fields. The library queries `"seedName"`, `"batch"`
and `"executedAt"` as quoted identifiers, so renaming a column breaks it — unlike
the table name, column names are not configurable.

Changing `ledgerTable` on a database that already has a ledger starts a new,
empty one: every seeder becomes pending again. Rename the existing table instead
if you want to keep the history.

## Examples

### A seed script for `package.json`

```ts
// prisma/seed.ts
import { PrismaClient } from '@prisma/client';
import { runSeeders } from 'prisma-seed';

const prisma = new PrismaClient();

try {
  const report = await runSeeders(prisma);
  console.log(`${report.executed.length} seeders applied (batch ${report.batch})`);
} finally {
  await prisma.$disconnect();
}
```

### Applying a single seeder programmatically

```ts
import { PrismaClient } from '@prisma/client';
import { runSeeders } from 'prisma-seed';

const prisma = new PrismaClient();
const report = await runSeeders(prisma, { only: 'User' });
await prisma.$disconnect();

if (report.executed.length === 0) {
  console.log(report.skipped); // e.g. [{ name: '..._User', reason: 'ya ejecutado' }]
}
```

### Inspecting a dry run

A dry run **does not** return the pending list — `executed` comes back empty and
the names are written to the logger instead. Pass your own logger to capture
them:

```ts
import { runSeeders, type Logger } from 'prisma-seed';

const lines: string[] = [];
const capture: Logger = {
  debug: () => {},
  info: (m) => lines.push(m),
  warn: () => {},
  error: () => {},
  success: (m) => lines.push(m),
};

await runSeeders(prisma, { dryRun: true, logger: capture });
console.log(lines); // ['Se ejecutarian 2 seeders:', '  - ..._User', '  - ..._Post']
```

### Resetting between test runs

```bash
npx prisma-seed fresh --seed --force
```

Truncates every table, resets autoincrement counters so ids start at 1 again,
then re-applies all seeders. Tables whose name starts with `_` are never touched
— that is where ORMs keep their migration bookkeeping. Add more exclusions with
`freshExclude`.

Without `--force` it asks for confirmation, and when there is no interactive
terminal it refuses rather than assuming yes, so it cannot wipe a database from
CI by accident. `--dry-run` lists what it would empty.

`refresh` is the surgical alternative: it calls each seeder's `down()` and
re-applies them, leaving everything else alone. It depends on your `down()`
functions being correct; `fresh` depends on nothing.

### Custom seeders directory

```ts
// seeder.config.ts
import { defineConfig } from 'prisma-seed';

export default defineConfig({
  seedersDir: 'db/seeds',
  ledgerTable: 'seed_history',
});
```

## TypeScript

The package ships `.d.ts` declarations and a dual ESM/CJS build; both `import`
and `require` resolve.

### Typing the context

`SeedContext` is generic in the client so a seeder gets full autocomplete:

```ts
import type { PrismaClient } from '@prisma/client';
import type { SeedContext } from 'prisma-seed';

type Ctx = SeedContext<PrismaClient>;
```

For a non-Prisma client, use the type of your own module:

```ts
import type { db } from '../../lib/db';
type Ctx = SeedContext<typeof db>;
```

The generic has **no constraint**, deliberately: requiring one would force a cast
on clients whose `$transaction` overloads do not line up exactly.

### Running TypeScript seeders

Node cannot execute `.ts` without a loader. Use the **`tsx` binary**:

```bash
npx tsx node_modules/prisma-seed/dist/cli.js run
```

Not `node --import tsx/esm`: it does not resolve `paths` aliases from
`tsconfig.json`, so a client module importing something like `@/db` fails to
load. The library's error message points this out when it happens.

A `seeder.config.ts` has the same constraint. Naming it `seeder.config.mjs`
avoids it for the config file, though not for `.ts` seeders.

### What `generate` writes

`generate` picks the language from, in order: `--ts` / `--js`, `seederLanguage`
in the configuration, the extension of the seeders already present,
`tsconfig.json`, and finally `package.json#type`. It prints which signal decided.

In TypeScript it imports `PrismaClient` only when your project can actually
resolve `@prisma/client`. Otherwise it emits a local placeholder interface plus
the single line you replace to type it properly — never `any`.

## Advanced usage

### Client lifecycle

| Who created the client | Who closes it |
|---|---|
| The library (`new PrismaClient()` fallback) | The library, always |
| Your `client` configuration | The **CLI**, because it owns the process. `closeClient: false` prevents this |
| You, via `runSeeders(client)` | **Only you.** The programmatic API never disconnects a borrowed client |

This matters: in an application the client is usually a shared module with a pool
behind it. Closing it would break the next use.

### Transactions

By default each seeder and its ledger write run inside one `$transaction`. Turn
it off per run with `--no-transaction`, or permanently with
`transactional: false` — needed for seeders that execute DDL, which forces an
implicit commit on MySQL, and for very large loads where a long transaction holds
locks.

The same options object is sent to every client; each applies what it
understands and ignores the rest.

### Choosing the dialect without a schema

If there is no schema file — or you do not want it read — set the engine
directly:

```ts
export default defineConfig({ provider: 'postgresql' });
```

## Troubleshooting

**`No se encontro el schema en "..."`** — no schema file was found at any of the
[searched locations](#schema-discovery). Set `schemaPath`, or skip schema reading
entirely with `provider`.

**`No se encontro "@prisma/client" en ...`** — the project has no Prisma client
and no `client` was configured. Either generate the Prisma client, or inject your
own via `seeder.config` / `runSeeders(client)`.

**`El cliente obtenido de ... no expone $queryRawUnsafe`** — the injected value
does not satisfy the contract. If your ORM blocks raw SQL through access
policies, inject the client without them.

**`No se puede ejecutar el seeder TypeScript "..."`** — Node has no `.ts` loader.
See [Running TypeScript seeders](#running-typescript-seeders).

**`"X" ya estaba ejecutado; no se vuelve a lanzar`** — expected. Roll it back
first if you want to repeat it.

**`"X" no exporta una funcion "main"`** — a seeder must export `main`. If it is a
CommonJS file, `module.exports = { main, down }` works too.

**`fresh vacia todas las tablas y no hay terminal para confirmarlo`** — you are
in a non-interactive shell. Pass `--force` deliberately, or `--dry-run` to see
the list first.

**A seeder ran but nothing was written** — check whether it threw after writing.
The seeder and its ledger record share a transaction, so a failure rolls back
both, and the seeder stays pending.

## Compatibility

| Technology | Support | Verified |
|---|---|---|
| `PrismaClient` (`@prisma/client` 6) | Supported | Yes — PostgreSQL 16, MySQL 8, SQLite |
| Prisma 5 | Declared in `peerDependencies` (`>=5 <7`, optional) | Not verified |
| Prisma 7 | Only by injecting the client; the automatic path needs driver adapters | Not verified |
| ZenStack v3 (`@zenstackhq/orm` 3.9.1) | Supported | Yes — PostgreSQL 17, in a Next.js 16 application |
| PostgreSQL | Supported | Yes |
| MySQL | Supported | Yes |
| SQLite | Supported | Yes |
| SQL Server | Implemented | **No** — the dialect has unit tests but has never run against a real server |
| MongoDB | Not supported | — |
| Node 22, Node 24 | Supported | Yes |
| Node 18, Node 20 | Not supported | Confirmed failing on 18 |

Next.js is not a dependency of `prisma-seed`, and no framework is. It appears
above only to describe the application in which ZenStack v3 compatibility was
verified.

### Known limitations

- **No concurrency lock.** Two simultaneous `run`s can apply the same seeder
  twice.
- **No dependency graph.** `SeederModule` declares `order` and `dependencies`,
  but the runner does not act on them; ordering is by filename only.
- **`fresh` empties, it does not drop.** Recreating the schema would mean
  invoking your ORM's CLI, which would couple the library to one implementation.

## License

[MIT](./LICENSE)

---

Further documentation: [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) ·
[`docs/MIGRACION.md`](./docs/MIGRACION.md) (coming from `prisma-seeder-custom`) ·
[`docs/IMPLEMENTACION.md`](./docs/IMPLEMENTACION.md) (architecture and design
decisions).
