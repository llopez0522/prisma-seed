#!/usr/bin/env bash
#
# Verifica la libreria contra el cliente REAL de un proyecto externo.
#
# No hay ningun proyecto por defecto: todo llega por entorno. La libreria no
# depende de ninguno — esto solo comprueba que la abstraccion aguanta contra un
# ORM de verdad que no es Prisma.
#
#   PROJECT_DIR=/ruta/al/proyecto \
#   CLIENT_MODULE=/app/lib/db.ts \
#   APP_CONTAINER=mi-app  DB_CONTAINER=mi-db \
#   DB_USER=... DB_PASSWORD=... \
#   ./tests/integration/real-client/run.sh
#
# Que hace:
#   1. Compila la libreria (se prueba el `dist` publicado, no la fuente).
#   2. Crea una base DE USAR Y TIRAR en el mismo servidor. La del proyecto no se
#      toca. Con SCHEMA_PUSH_CMD se le aplica el esquema.
#   3. Copia la libreria a `node_modules/` del contenedor y los fixtures al
#      proyecto. Cambios TEMPORALES; el trap los deshace siempre.
#   4. Comprueba los TIPOS contra el cliente real.
#   5. Ejecuta el test con el vitest del propio proyecto.
set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
LIB="$(cd "$AQUI/../../.." && pwd)"

: "${PROJECT_DIR:?define PROJECT_DIR: la raiz del proyecto consumidor}"
: "${APP_CONTAINER:?define APP_CONTAINER: el contenedor con node y node_modules}"
: "${DB_CONTAINER:?define DB_CONTAINER: el contenedor de la base de datos}"
: "${DB_USER:?define DB_USER}"
: "${DB_PASSWORD:?define DB_PASSWORD}"

CLIENT_MODULE="${CLIENT_MODULE:-/app/lib/db.ts}"
APP_DIR="${APP_DIR:-/app}"
DB_HOST="${DB_HOST:-db}"
TEST_DB="${TEST_DB:-psc_seedtest}"
KEEP_DB="${KEEP_DB:-0}"
SCHEMA_PUSH_CMD="${SCHEMA_PUSH_CMD:-}"

TEST_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:5432/${TEST_DB}"

limpiar() {
  echo
  echo "--- limpieza ---"
  rm -rf "$PROJECT_DIR/prisma" "$PROJECT_DIR/.psc-integration"
  docker exec "$APP_CONTAINER" rm -rf "$APP_DIR/node_modules/prisma-seed" || true
  if [ "$KEEP_DB" != "1" ]; then
    docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres \
      -c "DROP DATABASE IF EXISTS $TEST_DB" >/dev/null 2>&1 || true
    echo "base $TEST_DB eliminada"
  fi
  echo "revertido"
}
trap limpiar EXIT

echo "--- 1. compilando la libreria ---"
(cd "$LIB" && docker compose run --rm dev npm run build >/dev/null 2>&1)

echo "--- 2. base de usar y tirar: $TEST_DB ---"
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname='$TEST_DB'" | grep -q 1 ||
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE $TEST_DB" >/dev/null
if [ -n "$SCHEMA_PUSH_CMD" ]; then
  docker exec -e DATABASE_URL="$TEST_URL" "$APP_CONTAINER" \
    sh -lc "cd $APP_DIR && $SCHEMA_PUSH_CMD" | tail -2
fi

echo "--- 3. instalando la libreria y los fixtures ---"
docker exec "$APP_CONTAINER" rm -rf "$APP_DIR/node_modules/prisma-seed"
docker exec "$APP_CONTAINER" mkdir -p "$APP_DIR/node_modules/prisma-seed"
docker cp "$LIB/dist" "$APP_CONTAINER":"$APP_DIR/node_modules/prisma-seed/dist"
docker cp "$LIB/package.json" "$APP_CONTAINER":"$APP_DIR/node_modules/prisma-seed/package.json"

mkdir -p "$PROJECT_DIR/prisma" "$PROJECT_DIR/.psc-integration"
cp -R "$AQUI/seeders" "$PROJECT_DIR/prisma/seeders"
cp -R "$AQUI/seeders-fallo" "$PROJECT_DIR/prisma/seeders-fallo"
cp "$AQUI/real-client.integration.test.ts" "$PROJECT_DIR/.psc-integration/"
cp "$AQUI/vitest.real-client.config.mts" "$PROJECT_DIR/.psc-integration/"
cp "$LIB/tests/types/real-client.test-d.ts" "$PROJECT_DIR/.psc-integration/"

cat > "$PROJECT_DIR/.psc-integration/tsconfig.types.json" <<JSON
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true, "esModuleInterop": true,
    "baseUrl": "/",
    "paths": {
      "prisma-seed": ["$APP_DIR/node_modules/prisma-seed/dist/index.d.ts"],
      "@seed-real-client": ["$CLIENT_MODULE"],
      "@/*": ["$APP_DIR/*"]
    }
  },
  "include": ["$APP_DIR/.psc-integration/real-client.test-d.ts"]
}
JSON

echo "--- 4. tipos: SeedClient contra el cliente REAL ---"
docker exec "$APP_CONTAINER" \
  sh -lc "cd $APP_DIR && node_modules/.bin/tsc -p .psc-integration/tsconfig.types.json"
echo "OK: el cliente real es asignable a SeedClient sin cast"

echo "--- 5. ejecutando el test con el vitest del proyecto ---"
docker exec \
  -e DATABASE_URL="$TEST_URL" \
  -e SEED_REAL_PROJECT_DIR="$APP_DIR" \
  -e SEED_REAL_CLIENT_MODULE="$CLIENT_MODULE" \
  "$APP_CONTAINER" \
  sh -lc "cd $APP_DIR && npx vitest run --config .psc-integration/vitest.real-client.config.mts"
