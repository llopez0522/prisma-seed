/**
 * Contrato publico de la libreria.
 *
 * Se mantiene deliberadamente compatible con los seeders de la v0.2.4: un modulo
 * que exporta `main()` y `down()` sigue siendo valido. Lo nuevo (el contexto
 * inyectado, `order`, `dependencies`) es opcional.
 */

/** Motores soportados. Determina el dialecto SQL del ledger. */
export type Provider = 'postgresql' | 'mysql' | 'sqlite' | 'sqlserver';

/**
 * Lo que la libreria necesita saber hacer contra la base de datos.
 *
 * Son las dos unicas operaciones que ejecuta por su cuenta — mantener la tabla
 * del ledger — y las cumplen igual `PrismaClient` (`@prisma/client`) y
 * `ZenStackClient` (`@zenstackhq/orm`), que son los dos clientes con los que se
 * ha verificado. Cualquier otro que las exponga vale.
 *
 * Deliberadamente NO se importa `PrismaClient`: ese tipo solo existe una vez que
 * el usuario ha ejecutado `prisma generate`, y en un proyecto sin cliente
 * generado degrada a `any`. Con una interfaz estructural el nucleo queda tipado
 * siempre y ademas no ata la libreria a ninguna implementacion.
 */
export interface RawSqlClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * Opciones de transaccion.
 *
 * Es la union de lo que aceptan las implementaciones conocidas, y **cada cliente
 * usa lo que entiende e ignora el resto**. Comprobado:
 *
 * | Opcion | Prisma 5/6 | ZenStack 3.9.1 |
 * |---|---|---|
 * | `timeout` | la aplica | la ignora |
 * | `maxWait` | la aplica | la ignora |
 * | `isolationLevel` | la aplica | la aplica |
 *
 * Por eso la libreria envia siempre el mismo objeto y no necesita saber con quien
 * habla. `isolationLevel` es `string` y no una union cerrada porque Prisma usa su
 * propia union y ZenStack un `enum`: `string` es el unico supertipo comun, y es
 * lo que hace que las dos firmas reales sean asignables a esta.
 */
export interface SeedTransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: string;
}

/**
 * El contrato del cliente. Es la unica dependencia de la libreria hacia el ORM.
 *
 * Obligatorio: el SQL crudo. Todo lo demas es **una capacidad opcional**, y lo es
 * porque de verdad puede faltar, no para esquivar el sistema de tipos: el cliente
 * que se recibe DENTRO de una transaccion no tiene ni `$transaction` ni
 * `$connect` ni `$disconnect` en ninguna de las dos implementaciones
 * (`ITXClientDenyList` en Prisma, `TRANSACTION_UNSUPPORTED_METHODS` en ZenStack),
 * y ese cliente es justo el que el runner inyecta en los seeders.
 *
 * La asignabilidad no se supone, se compila: `tests/types/` asigna a este tipo un
 * `PrismaClient` generado de verdad y un `ZenStackClient` de verdad.
 */
export interface SeedClient extends RawSqlClient {
  /** Conexion explicita. Ausente en el cliente de transaccion. */
  $connect?: () => Promise<void>;
  /** Cierre explicito. Quien crea el cliente decide quien lo llama. */
  $disconnect?: () => Promise<void>;
  /**
   * Transaccion interactiva.
   *
   * El callback recibe un `SeedClient` porque el cliente de transaccion real de
   * ambos ORMs encaja ahi: le sobran metodos y los que le faltan son opcionales.
   */
  $transaction?<R>(
    fn: (tx: SeedClient) => Promise<R>,
    options?: SeedTransactionOptions
  ): Promise<R>;
}

/**
 * Nombre anterior de `SeedClient`.
 *
 * @deprecated Usa `SeedClient`.
 */
export type PrismaLike = SeedClient;

/** Fabrica de cliente. Puede ser sincrona o asincrona. */
export type SeedClientFactory = () => SeedClient | Promise<SeedClient>;

/** Lo que se puede declarar en `client` dentro de la configuracion. */
export type SeedClientSource = SeedClient | SeedClientFactory;

/**
 * Lenguaje de los seeders que escribe `generate`.
 *
 * `ts` emite TypeScript; `esm` y `cjs`, JavaScript con `export` o con
 * `module.exports`.
 */
export type SeederLanguage = 'ts' | 'esm' | 'cjs';

/**
 * Como debe tiparse el cliente en los seeders que genera `generate --ts`.
 *
 * Por defecto la plantilla usa `PrismaClient` de `@prisma/client`. En un proyecto
 * que no pueda resolver ese paquete eso generaria un archivo que no compila, asi
 * que declarando esto se emite el tipo del cliente real:
 *
 * ```ts
 * clientType: {
 *   import: "import type { db } from '../../src/db'",
 *   type: 'typeof db',
 * }
 * ```
 */
export interface ClientTypeSpec {
  /** Linea de import completa, sin punto y coma final. */
  import: string;
  /** Expresion de tipo que se pasa a `SeedContext<...>`. */
  type: string;
}

/**
 * Que sabe hacer un cliente concreto, resuelto en tiempo de ejecucion.
 *
 * Se mira la **capacidad**, nunca la marca: la libreria no pregunta "¿eres
 * Prisma?" en ningun punto.
 */
export interface SeedClientCapabilities {
  transactions: boolean;
  connect: boolean;
  disconnect: boolean;
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  success(msg: string): void;
}

/**
 * Se inyecta en `main()` y `down()`. Compartir el cliente evita que cada seeder
 * abra su propio pool, que es lo que ocurria en la v0.2.4.
 *
 * Es generico en el tipo de cliente para que un seeder en TypeScript pida el
 * suyo, ya generado y con todos los modelos. El parametro **no lleva
 * restriccion** a proposito: un `ClientContract` de ZenStack v3 no tiene por que
 * ser estructuralmente asignable a `SeedClient` en todas sus sobrecargas, y
 * exigirselo obligaria al usuario a un cast.
 *
 * ```ts
 * // Prisma tradicional
 * import type { PrismaClient } from '@prisma/client';
 * export async function main({ prisma }: SeedContext<PrismaClient>) { ... }
 *
 * // Cualquier otro cliente del proyecto
 * import type { db } from '../src/db';
 * export async function main({ prisma }: SeedContext<typeof db>) { ... }
 * ```
 */
export interface SeedContext<TClient = SeedClient> {
  /**
   * El cliente inyectado. Se llama `prisma` por continuidad con los seeders ya
   * escritos; `client` es el mismo objeto con un nombre neutral, pensado para
   * proyectos que no usan Prisma directamente.
   */
  prisma: TClient;
  /** Alias de `prisma`. Misma referencia, nunca una instancia distinta. */
  client: TClient;
  logger: Logger;
  /** Nombre del seeder en ejecucion, sin extension. */
  name: string;
}

/** Forma de un modulo de seeder tras cargarlo. */
export interface SeederModule {
  main?: (ctx: SeedContext) => Promise<void> | void;
  down?: (ctx: SeedContext) => Promise<void> | void;
  /** Prioridad explicita. Si se omite, ordena el prefijo de timestamp. */
  order?: number;
  /** Nombres de seeders que deben ejecutarse antes que este. */
  dependencies?: string[];
}

/** Un seeder descubierto en disco, antes de cargarse. */
export interface DiscoveredSeeder {
  /** Nombre canonico: nombre de archivo sin extension. */
  name: string;
  absolutePath: string;
  /** Prefijo de timestamp extraido del nombre, si lo tiene. */
  timestamp: string | null;
}

/** Fila del ledger de ejecuciones. */
export interface SeedExecutionRecord {
  id: number;
  seedName: string;
  batch: number;
  executedAt: Date;
}

export interface SeederConfig {
  /** Directorio de seeders, relativo a la raiz del proyecto. */
  seedersDir: string;
  /**
   * Ruta al schema del que se lee el `provider`.
   *
   * Vale tanto un `schema.prisma` como un `schema.zmodel`: los dos declaran un
   * bloque `datasource` con el mismo campo. Si no se indica, se autodetecta
   * (ver `core/project.ts`).
   */
  schemaPath: string;
  /** Nombre de la tabla del ledger. */
  ledgerTable: string;
  /** Envolver cada seeder en una transaccion junto con su registro en el ledger. */
  transactional: boolean;
  /**
   * Tiempo maximo por transaccion, en milisegundos.
   *
   * Prisma usa 5 s por defecto en transacciones interactivas, que es muy poco para
   * sembrar datos: un seeder con unos miles de filas lo agota. Se sube a 5 min.
   *
   * Se envia siempre; **un cliente que no soporte la opcion la ignora** y ahi el
   * limite lo pone el driver. Comprobado con ZenStack 3.9.1, que solo lee
   * `isolationLevel`.
   */
  transactionTimeout: number;
  /** Provider explicito. Si se omite, se deduce del schema. */
  provider?: Provider;
  /**
   * Cliente que debe usar la libreria, o una fabrica que lo devuelva.
   *
   * Es el punto de inyeccion para cualquier proyecto cuyo cliente no se pueda
   * construir con `new PrismaClient()`: otro ORM sobre el mismo contrato, Prisma
   * 7 con driver adapter, o cualquier montaje con extensiones, logging o URL
   * propia.
   *
   * Si se omite, la libreria resuelve `@prisma/client` desde el proyecto y crea
   * el cliente ella misma, exactamente como hasta ahora.
   */
  client?: SeedClientSource;
  /**
   * Lenguaje de los seeders que escribe `generate`.
   *
   * Si se omite se deduce del proyecto (ver `detectFlavor` en
   * `commands/generate.ts`). Fijarlo aqui salta toda la deteccion, que es lo que
   * hay que hacer cuando la deduccion no acierta.
   */
  seederLanguage?: SeederLanguage;
  /**
   * Tipo del cliente que emiten los seeders TypeScript generados.
   *
   * Solo afecta a los seeders en TypeScript. No cambia nada en tiempo de ejecucion.
   */
  clientType?: ClientTypeSpec;
  /**
   * Tablas que `fresh` no debe vaciar, ademas de las reservadas.
   *
   * Las que empiezan por `_` ya quedan fuera siempre: son el registro de
   * migraciones del ORM (`_prisma_migrations`). Esto es para las demas — un
   * catalogo que se carga por otra via, una tabla de otro sistema que comparte
   * base.
   */
  freshExclude?: string[];
  /**
   * Si el CLI debe cerrar el cliente al terminar. Por defecto `true`.
   *
   * Solo afecta al CLI, que es dueno del proceso. La API programatica
   * (`runSeeders`) **nunca** cierra un cliente que no ha creado.
   */
  closeClient?: boolean;
}

/**
 * Configuracion parcial escrita por el usuario.
 *
 * No es `Partial<SeederConfig>`: con `exactOptionalPropertyTypes` activado, ese
 * tipo prohibe pasar `undefined` de forma explicita, y quien llama a `loadConfig`
 * suele construir el objeto a partir de flags del CLI que estan sin definir. Se
 * admite `undefined` y `stripUndefined` lo descarta al fusionar.
 */
export type UserSeederConfig = { [K in keyof SeederConfig]?: SeederConfig[K] | undefined };

/** Helper tipado para `seeder.config.ts`. */
export function defineConfig(config: UserSeederConfig): UserSeederConfig {
  return config;
}
