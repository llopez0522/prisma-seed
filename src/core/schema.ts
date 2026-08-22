import fs from 'node:fs';

import { CliError, EXIT } from './errors.js';
import type { Provider } from '../types.js';

/**
 * Lectura del schema del proyecto.
 *
 * Solo extrae el `provider` del bloque `datasource`, que es lo que la capa de
 * dialecto necesita para emitir SQL correcto en cada motor. La v0.2.4 no leia el
 * schema en absoluto y asumia Postgres, de ahi B3.
 *
 * **Sirve igual para `schema.prisma` que para `schema.zmodel`.** ZModel hereda de
 * Prisma el bloque `datasource` con el campo `provider`
 * (https://zenstack.dev/docs/reference/zmodel/datasource), asi que el mismo
 * parseo cubre los dos ecosistemas. La unica diferencia real es el
 * entrecomillado: los ejemplos canonicos de ZModel usan comillas simples
 * (`provider = 'postgresql'`) y los de Prisma dobles. Se aceptan ambas.
 *
 * Se hace con una expresion regular en vez de con `@prisma/internals` a proposito:
 * `getDMMF` arrastra una dependencia pesada, es exclusiva de Prisma y aqui basta
 * con un dato del bloque datasource.
 */

const DATASOURCE_BLOCK = /datasource\s+\w+\s*\{([^}]*)\}/;
const PROVIDER_FIELD = /provider\s*=\s*(?:"([^"]+)"|'([^']+)')/;

const KNOWN_PROVIDERS: readonly string[] = [
  'postgresql',
  'postgres',
  'mysql',
  'sqlite',
  'sqlserver',
];

/** Normaliza los alias que acepta Prisma. */
function normalizeProvider(raw: string): Provider | null {
  switch (raw) {
    case 'postgresql':
    case 'postgres':
      return 'postgresql';
    case 'mysql':
      return 'mysql';
    case 'sqlite':
      return 'sqlite';
    case 'sqlserver':
      return 'sqlserver';
    default:
      return null;
  }
}

/** Extrae el provider del contenido de un schema.prisma. */
export function parseProvider(schemaContents: string): Provider | null {
  const block = DATASOURCE_BLOCK.exec(schemaContents);
  if (!block?.[1]) return null;

  const field = PROVIDER_FIELD.exec(block[1]);
  const raw = field?.[1] ?? field?.[2];
  if (raw === undefined) return null;

  return normalizeProvider(raw);
}

/**
 * Lee el provider desde el archivo de schema.
 *
 * Lanza si no puede determinarlo: adivinar en silencio es justo lo que produjo
 * los fallos de B3, y un motor equivocado corrompe el ledger.
 */
export function readProvider(schemaPath: string): Provider {
  if (!fs.existsSync(schemaPath)) {
    throw new CliError(
      `No se encontro el schema en "${schemaPath}".`,
      EXIT.USAGE,
      'Indica su ubicacion con "schemaPath" en seeder.config, o fija el motor ' +
        'directamente con "provider". Se buscan por defecto prisma/schema.prisma ' +
        'y zenstack/schema.zmodel.'
    );
  }

  const contents = fs.readFileSync(schemaPath, 'utf8');
  const provider = parseProvider(contents);

  if (!provider) {
    throw new CliError(
      `No se pudo determinar el "provider" del bloque datasource en "${schemaPath}".`,
      EXIT.USAGE,
      `Motores soportados: ${KNOWN_PROVIDERS.join(', ')}. ` +
        'Tambien puedes fijarlo con "provider" en seeder.config.'
    );
  }

  return provider;
}
