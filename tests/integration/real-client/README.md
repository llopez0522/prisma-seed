# Verificación contra el cliente real de un proyecto externo

La librería **no depende de ningún proyecto**. Esto solo comprueba que la
abstracción aguanta contra un ORM de verdad que no es Prisma.

`npm run test:integration` **salta** estos tests y lo dice. No corren en CI.

## Qué añade sobre los dobles

`tests/integration/injection.test.ts` prueba dos implementaciones del contrato en
los tres motores y corre siempre. Esto prueba el paquete real, y hacía falta:
contra él aparecieron cosas que un doble no puede ver.

- Que la documentación de un ORM puede no coincidir con su `.d.ts`.
- Que un cliente **ignora en silencio** las opciones de transacción que no
  entiende — que es lo que permite a la librería enviar siempre el mismo objeto y
  no bifurcar por implementación.
- Que `node --import tsx/esm` no resuelve los alias `paths` del tsconfig, y el
  binario `tsx` sí.

## Cómo se ejecutan

Todo por entorno; no hay ningún proyecto por defecto.

```bash
PROJECT_DIR=/ruta/al/proyecto \
APP_CONTAINER=mi-app \
DB_CONTAINER=mi-db \
DB_USER=usuario DB_PASSWORD=secreto \
CLIENT_MODULE=/app/lib/db.ts \
SCHEMA_PUSH_CMD='npx zen db push --accept-data-loss --no-version-check' \
./tests/integration/real-client/run.sh
```

| Variable | Qué es |
|---|---|
| `PROJECT_DIR` | raíz del proyecto en el **host** |
| `APP_CONTAINER` | contenedor con node y los `node_modules` del proyecto |
| `DB_CONTAINER` | contenedor de Postgres |
| `DB_USER` / `DB_PASSWORD` | credenciales |
| `CLIENT_MODULE` | ruta **dentro del contenedor** del módulo que exporta `db` |
| `APP_DIR` | raíz dentro del contenedor (`/app`) |
| `DB_HOST` | host de la base en la red de contenedores (`db`) |
| `TEST_DB` | base de usar y tirar (`psc_seedtest`) |
| `SCHEMA_PUSH_CMD` | opcional: cómo aplicar el esquema a la base de prueba |
| `KEEP_DB` | `1` para conservarla entre ejecuciones |

`run-cli.sh` toma las mismas variables más `CLIENT_MODULE_REL` (la ruta relativa
que usará `seeder.config.mjs`) y `SUBDIR` (desde dónde lanzar el CLI, para probar
el descubrimiento de la raíz).

## Qué tocan, y por qué es seguro

La base del proyecto **no se toca**: se crea otra en el mismo servidor.

Los cambios en el proyecto son temporales y un `trap` los revierte aunque el test
falle:

| Ruta | Qué es |
|---|---|
| `<proyecto>/prisma/seeders/` | 2 seeders de prueba |
| `<proyecto>/prisma/seeders-fallo/` | 1 seeder que falla a propósito |
| `<proyecto>/.psc-integration/` | el test, su config de vitest y el tsconfig de tipos |
| `<proyecto>/seeder.config.mjs` | solo en `run-cli.sh` |
| `node_modules/prisma-seed/` | el `dist`, dentro del volumen del contenedor |

Los seeders **no conocen ningún modelo del proyecto**: usan solo SQL crudo sobre
su propia tabla `psc_seed_probe`, que se crea y se borra. Por eso sirven para
cualquier consumidor.

Para comprobar que no queda nada:

```bash
cd <proyecto> && git status --porcelain     # vacío
```
