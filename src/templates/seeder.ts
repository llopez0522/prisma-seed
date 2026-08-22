import { toModelAccessor, toModelName } from '../core/naming.js';
import type { ClientTypeSpec } from '../types.js';

/**
 * Plantillas de seeder.
 *
 * Tres cambios de fondo respecto de la v0.2.4:
 *
 *  - **El cliente llega inyectado** (B12). Antes cada archivo generado hacia su
 *    propio `new PrismaClient()` y ninguno se desconectaba: N seeders eran N pools
 *    de conexion. Ahora `main` y `down` reciben el cliente compartido.
 *  - **El accesor se calcula bien** (B9). `UserProfile` genera `prisma.userProfile`,
 *    no `prisma.userprofile`, que no existe.
 *  - **El tipo del cliente es configurable**. La plantilla TypeScript importaba
 *    `PrismaClient` de `@prisma/client` sin alternativa, lo que rompe en un
 *    proyecto de ZenStack v3 (donde ese paquete puede no estar) o en uno de
 *    Prisma 7 con output propio. Ahora se puede declarar `clientType` en la
 *    configuracion; el valor por defecto sigue siendo el de Prisma.
 *
 * Los seeders de la v0.2.4 siguen funcionando: el cargador acepta modulos que
 * ignoran el contexto y crean su propio cliente.
 */

export type TemplateFlavor = 'esm' | 'cjs' | 'ts';

export interface TemplateOptions {
  /** Nombre del seeder, que tambien da el modelo por defecto. */
  name: string;
  /** Modelo al que apunta. Por defecto, el propio nombre. */
  model?: string;
  /**
   * Como tipar el cliente en la plantilla TypeScript.
   *
   * Si se omite, se usa `PrismaClient` de `@prisma/client`. Si se pasa `null`,
   * se emite un `SeedContext` sin parametrizar y un comentario que explica como
   * tiparlo: es lo que se genera en un proyecto donde no consta que
   * `@prisma/client` exista.
   */
  clientType?: ClientTypeSpec | null;
}

/** Tipado por defecto: el de un proyecto Prisma tradicional. */
export const PRISMA_CLIENT_TYPE: ClientTypeSpec = {
  import: "import type { PrismaClient } from '@prisma/client'",
  type: 'PrismaClient',
};

function cuerpo(accessor: string, model: string): { main: string; down: string } {
  return {
    main: `  // Ajusta los campos a tu modelo "${model}" en el schema del proyecto.
  const registro = await prisma.${accessor}.upsert({
    where: { id: 1 },
    update: {},
    create: {
      // TODO: completar con los campos reales de ${model}.
    },
  });

  logger.info(\`${accessor} creado: \${JSON.stringify(registro)}\`);`,
    down: `  // La condicion debe identificar exactamente lo que creo main().
  const { count } = await prisma.${accessor}.deleteMany({
    where: { id: 1 },
  });

  logger.info(\`${accessor}: \${count} registros eliminados.\`);`,
  };
}

export function renderTemplate(flavor: TemplateFlavor, options: TemplateOptions): string {
  const model = toModelName(options.model ?? options.name);
  const accessor = toModelAccessor(model);
  const { main, down } = cuerpo(accessor, model);

  if (flavor === 'ts') {
    return renderTypeScript(options.clientType, { accessor, model, main, down });
  }

  if (flavor === 'cjs') {
    return `// El cliente y el logger los inyecta el runner: no crees aqui un PrismaClient
// propio, o abriras un pool de conexiones por cada seeder.

/** @param {import('prisma-seed').SeedContext} ctx */
async function main({ prisma, logger }) {
${main}
}

/** @param {import('prisma-seed').SeedContext} ctx */
async function down({ prisma, logger }) {
${down}
}

module.exports = { main, down };
`;
  }

  return `// El cliente y el logger los inyecta el runner: no crees aqui un PrismaClient
// propio, o abriras un pool de conexiones por cada seeder.

/** @param {import('prisma-seed').SeedContext} ctx */
export async function main({ prisma, logger }) {
${main}
}

/** @param {import('prisma-seed').SeedContext} ctx */
export async function down({ prisma, logger }) {
${down}
}
`;
}

interface TypeScriptParts {
  accessor: string;
  model: string;
  main: string;
  down: string;
}

/**
 * Cabecera cuando no consta cual es el cliente del proyecto.
 *
 * Se declara una interfaz local con **solo** los dos metodos que usa la
 * plantilla. Es la alternativa a rellenar con `any`: el archivo generado compila
 * tal cual, sin tipado ficticio, y la unica linea que hay que cambiar para tener
 * autocompletado real esta justo encima, comentada.
 */
function placeholderClientType(accessor: string, model: string): string {
  return `import type { SeedContext } from 'prisma-seed';

/**
 * Cliente del proyecto. Sustituye esta interfaz por el tipo real para tener
 * autocompletado sobre todos los modelos. Con ZenStack v3:
 *
 *   import type { db } from '../../src/db';
 *   type AppClient = typeof db;
 */
interface AppClient {
  ${accessor}: {
    upsert(args: {
      where: { id: number };
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    }): Promise<unknown>;
    deleteMany(args: { where: { id: number } }): Promise<{ count: number }>;
  };
}

// El tipo describe lo que necesita este seeder de "${model}", nada mas.
type Ctx = SeedContext<AppClient>;`;
}

/**
 * Plantilla TypeScript.
 *
 * El bloque de tipado del cliente es lo unico que varia: el resto del cuerpo es
 * identico se use Prisma o ZenStack, que es justo lo que se busca — el seeder no
 * sabe de donde sale su cliente.
 */
function renderTypeScript(
  clientType: ClientTypeSpec | null | undefined,
  parts: TypeScriptParts
): string {
  const spec = clientType === undefined ? PRISMA_CLIENT_TYPE : clientType;

  const cabecera =
    spec === null
      ? placeholderClientType(parts.accessor, parts.model)
      : `${spec.import};
import type { SeedContext } from 'prisma-seed';

type Ctx = SeedContext<${spec.type}>;`;

  return `${cabecera}

// El cliente y el logger los inyecta el runner: no crees aqui un cliente propio,
// o abriras un pool de conexiones por cada seeder.

export async function main({ prisma, logger }: Ctx): Promise<void> {
${parts.main}
}

export async function down({ prisma, logger }: Ctx): Promise<void> {
${parts.down}
}
`;
}

/** Extension que corresponde a cada variante. */
export function extensionFor(flavor: TemplateFlavor): string {
  return flavor === 'ts' ? '.ts' : '.js';
}
