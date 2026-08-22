import { ConnectionError, toMessage } from './errors.js';
import { getPrismaClient } from './prisma.js';
import type {
  Logger,
  SeedClient,
  SeedClientCapabilities,
  SeedClientSource,
  SeedTransactionOptions,
} from '../types.js';

/**
 * Adaptador del cliente. **El unico punto de la libreria que trata con el ORM.**
 *
 * Todo lo que hay aqui razona sobre CAPACIDADES, nunca sobre implementaciones:
 * no existe ni una comprobacion de "¿esto es Prisma?" o "¿esto es ZenStack?".
 * El resto del nucleo — ledger, runner, comandos — solo ve `SeedClient`.
 *
 * Por que basta con capacidades, medido sobre `@prisma/client@6` y
 * `@zenstackhq/orm@3.9.1`:
 *
 *  - **SQL crudo**: firma identica en ambos. Nada que adaptar.
 *  - **Transaccion**: ambos exponen `$transaction(fn, options?)`. Las opciones
 *    que entienden difieren, pero **las que no entienden las ignoran** — se
 *    comprobo en ejecucion contra un ZenStackClient real. Asi que se envia
 *    siempre el mismo objeto y no hay bifurcacion.
 *  - **Ciclo de vida**: `$connect`/`$disconnect` existen en el cliente de nivel
 *    superior de ambos y faltan en el de transaccion de ambos. Por eso son
 *    opcionales y se comprueban antes de llamarlos.
 */

/** Que sabe hacer este cliente. Se pregunta por la capacidad, no por la marca. */
export function capabilitiesOf(client: SeedClient): SeedClientCapabilities {
  return {
    transactions: typeof client.$transaction === 'function',
    connect: typeof client.$connect === 'function',
    disconnect: typeof client.$disconnect === 'function',
  };
}

/** Atajo legible para la unica capacidad que condiciona el flujo del runner. */
export function supportsTransactions(client: SeedClient): boolean {
  return capabilitiesOf(client).transactions;
}

/** Comprueba que el valor inyectado cumple el contrato antes de usarlo. */
export function assertSeedClient(value: unknown, origin: string): asserts value is SeedClient {
  if (typeof value !== 'object' || value === null) {
    throw new ConnectionError(
      `El cliente obtenido de ${origin} no es un objeto (se recibio ${typeof value}).`,
      'Debe ser un cliente con $queryRawUnsafe y $executeRawUnsafe: PrismaClient, ' +
        'ZenStackClient o cualquier otro que cumpla el contrato.'
    );
  }

  const candidate = value as Partial<SeedClient>;
  const missing: string[] = [];
  if (typeof candidate.$queryRawUnsafe !== 'function') missing.push('$queryRawUnsafe');
  if (typeof candidate.$executeRawUnsafe !== 'function') missing.push('$executeRawUnsafe');

  if (missing.length > 0) {
    throw new ConnectionError(
      `El cliente obtenido de ${origin} no expone ${missing.join(' ni ')}.`,
      'La libreria necesita SQL crudo para mantener la tabla del ledger. Si tu ORM ' +
        'lo bloquea por politicas de acceso, inyecta el cliente sin ellas.'
    );
  }
}

/**
 * Ejecuta `fn` dentro de una transaccion del cliente.
 *
 * Sin casts y sin bifurcaciones: `SeedClient.$transaction` esta declarado con su
 * firma real y el `typeof` lo estrecha. Las opciones van siempre; el cliente
 * aplica las que soporta.
 */
export async function runInTransaction(
  client: SeedClient,
  fn: (tx: SeedClient) => Promise<void>,
  options: SeedTransactionOptions
): Promise<void> {
  if (typeof client.$transaction !== 'function') {
    throw new ConnectionError(
      'El cliente inyectado no expone $transaction.',
      'Ejecuta con --no-transaction, o pon "transactional: false" en seeder.config.'
    );
  }

  await client.$transaction(fn, options);
}

/** Abre la conexion si el cliente lo permite. Tolera que no. */
export async function connectClient(client: SeedClient): Promise<void> {
  if (typeof client.$connect !== 'function') return;
  await client.$connect();
}

/** Cierra la conexion si el cliente lo permite. Tolera que no. */
export async function disconnectClient(client: SeedClient): Promise<void> {
  if (typeof client.$disconnect !== 'function') return;
  await client.$disconnect();
}

export interface ResolveClientOptions {
  /** Raiz del proyecto del usuario. */
  cwd: string;
  /** Valor de `client` en la configuracion, si lo hay. */
  source?: SeedClientSource | undefined;
  /** Cliente ya construido por quien llama. Gana a todo. */
  injected?: SeedClient | undefined;
  logger?: Logger | undefined;
}

export interface ResolvedClient {
  client: SeedClient;
  capabilities: SeedClientCapabilities;
  /** De donde salio el cliente. */
  origin: 'injected' | 'config' | 'auto';
  /**
   * Si lo construyo la libreria.
   *
   * Es lo unico que decide quien puede cerrarlo: la libreria solo destruye lo
   * que ella ha creado.
   */
  createdByLibrary: boolean;
}

function isFactory(source: SeedClientSource): source is () => SeedClient | Promise<SeedClient> {
  return typeof source === 'function';
}

/**
 * Resuelve el cliente de toda la ejecucion. Se llama **una sola vez** por
 * contexto, y ese objeto es el que reciben el ledger y cada seeder.
 *
 * Precedencia:
 *   1. El que pasa quien llama — `runSeeders(client)`.
 *   2. El declarado en `client` de la configuracion (valor o fabrica).
 *   3. `new PrismaClient()` resuelto desde el proyecto, como respaldo.
 */
export async function resolveSeedClient(options: ResolveClientOptions): Promise<ResolvedClient> {
  const { cwd, source, injected, logger } = options;

  if (injected !== undefined) {
    assertSeedClient(injected, 'la llamada a runSeeders()');
    return describe(injected, 'injected', false, logger);
  }

  if (source !== undefined) {
    const value = await produceFromConfig(source);
    assertSeedClient(value, 'la clave "client" de la configuracion');
    return describe(value, 'config', false, logger);
  }

  return describe(getPrismaClient({ cwd }), 'auto', true, logger);
}

function describe(
  client: SeedClient,
  origin: ResolvedClient['origin'],
  createdByLibrary: boolean,
  logger: Logger | undefined
): ResolvedClient {
  const capabilities = capabilitiesOf(client);
  const soporta = Object.entries(capabilities)
    .filter(([, yes]) => yes)
    .map(([name]) => name)
    .join(', ');

  logger?.debug(`Cliente: ${ORIGEN[origin]} — capacidades: ${soporta || 'solo SQL crudo'}`);

  return { client, capabilities, origin, createdByLibrary };
}

const ORIGEN: Record<ResolvedClient['origin'], string> = {
  injected: 'inyectado por el programa',
  config: 'fabricado por seeder.config',
  auto: 'creado por la libreria desde @prisma/client',
};

async function produceFromConfig(source: SeedClientSource): Promise<unknown> {
  if (!isFactory(source)) return source;

  try {
    return await source();
  } catch (error) {
    throw new ConnectionError(
      `La fabrica "client" de la configuracion fallo: ${toMessage(error)}`,
      hintForFactoryFailure(error)
    );
  }
}

/**
 * Pista para el fallo mas frecuente al inyectar el cliente.
 *
 * Medido: si el modulo del cliente importa algo por un alias de `paths` del
 * tsconfig, lanzarlo con `node --import tsx/esm` no lo resuelve y el import muere
 * con MODULE_NOT_FOUND. El binario `tsx` si.
 */
function hintForFactoryFailure(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;

  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    return (
      'No se pudo importar un modulo desde la fabrica. Si la ruta es un alias de ' +
      '"paths" del tsconfig, lanza el CLI con el binario de tsx — ' +
      'npx tsx node_modules/prisma-seed/dist/cli.js <comando> — y no con ' +
      '"node --import tsx/esm", que no los resuelve.'
    );
  }

  return 'Debe devolver un cliente ya construido que cumpla el contrato SeedClient.';
}
