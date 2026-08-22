#!/usr/bin/env bash
#
# Igual que run.sh pero ejercitando el BINARIO contra el cliente real:
# descubrimiento de raiz desde un subdirectorio, `client` inyectado desde
# `seeder.config.mjs`, `generate`, `run` y `rollback`.
#
# Los seeders son TypeScript, asi que el CLI se lanza con el binario `tsx`. No con
# `node --import tsx/esm`: medido, ese no resuelve los alias `paths` del tsconfig
# y el modulo del cliente no llega a cargar.
set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
LIB="$(cd "$AQUI/../../.." && pwd)"

: "${PROJECT_DIR:?define PROJECT_DIR}"
: "${APP_CONTAINER:?define APP_CONTAINER}"
: "${DB_CONTAINER:?define DB_CONTAINER}"
: "${DB_USER:?define DB_USER}"
: "${DB_PASSWORD:?define DB_PASSWORD}"

CLIENT_MODULE_REL="${CLIENT_MODULE_REL:-./lib/db.ts}"
APP_DIR="${APP_DIR:-/app}"
SUBDIR="${SUBDIR:-$APP_DIR}"
DB_HOST="${DB_HOST:-db}"
TEST_DB="${TEST_DB:-psc_seedtest}"
KEEP_DB="${KEEP_DB:-0}"
SCHEMA_PUSH_CMD="${SCHEMA_PUSH_CMD:-}"

TEST_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:5432/${TEST_DB}"
CLI="$APP_DIR/node_modules/prisma-seed/dist/cli.js"

limpiar() {
  echo
  echo "--- limpieza ---"
  rm -rf "$PROJECT_DIR/prisma" "$PROJECT_DIR/seeder.config.mjs"
  docker exec "$APP_CONTAINER" rm -rf "$APP_DIR/node_modules/prisma-seed" || true
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$TEST_DB" -q \
    -c 'DROP TABLE IF EXISTS "psc_seed_probe"' -c 'DROP TABLE IF EXISTS "SeedExecution"' \
    >/dev/null 2>&1 || true
  if [ "$KEEP_DB" != "1" ]; then
    docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres \
      -c "DROP DATABASE IF EXISTS $TEST_DB" >/dev/null 2>&1 || true
  fi
  echo "revertido"
}
trap limpiar EXIT

echo "--- preparando ---"
(cd "$LIB" && docker compose run --rm dev npm run build >/dev/null 2>&1)
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname='$TEST_DB'" | grep -q 1 ||
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE $TEST_DB" >/dev/null
if [ -n "$SCHEMA_PUSH_CMD" ]; then
  docker exec -e DATABASE_URL="$TEST_URL" "$APP_CONTAINER" \
    sh -lc "cd $APP_DIR && $SCHEMA_PUSH_CMD" >/dev/null
fi
docker exec "$APP_CONTAINER" rm -rf "$APP_DIR/node_modules/prisma-seed"
docker exec "$APP_CONTAINER" mkdir -p "$APP_DIR/node_modules/prisma-seed"
docker cp "$LIB/dist" "$APP_CONTAINER":"$APP_DIR/node_modules/prisma-seed/dist"
docker cp "$LIB/package.json" "$APP_CONTAINER":"$APP_DIR/node_modules/prisma-seed/package.json"

mkdir -p "$PROJECT_DIR/prisma"
cp -R "$AQUI/seeders" "$PROJECT_DIR/prisma/seeders"

# La integracion completa del consumidor: una linea.
cat > "$PROJECT_DIR/seeder.config.mjs" <<CFG
export default {
  client: async () => (await import('$CLIENT_MODULE_REL')).db,
};
CFG

# Estado de partida limpio: la tabla sonda que usan los seeders y sin ledger.
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$TEST_DB" -q \
  -c 'DROP TABLE IF EXISTS "SeedExecution"' \
  -c 'CREATE TABLE IF NOT EXISTS "psc_seed_probe" ("clave" VARCHAR(50) PRIMARY KEY, "valor" VARCHAR(50))' \
  -c 'DELETE FROM "psc_seed_probe"' >/dev/null

ejecutar() {
  docker exec -e DATABASE_URL="$TEST_URL" "$APP_CONTAINER" \
    sh -lc "cd $1 && npx tsx $CLI ${*:2}"
}

echo
echo "=== 1. generate --ts ==="
ejecutar "$APP_DIR" generate PruebaCli --ts
head -12 "$PROJECT_DIR"/prisma/seeders/*_PruebaCli.ts
rm -f "$PROJECT_DIR"/prisma/seeders/*_PruebaCli.ts

echo
echo "=== 2. run --verbose desde $SUBDIR ==="
ejecutar "$SUBDIR" run --verbose

echo
echo "=== 3. estado en la base ==="
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$TEST_DB" \
  -c 'SELECT "seedName", batch FROM "SeedExecution" ORDER BY id'
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$TEST_DB" \
  -c 'SELECT * FROM "psc_seed_probe" ORDER BY "clave"'

echo "=== 4. segunda pasada: no repite ==="
ejecutar "$APP_DIR" run

echo
echo "=== 5. rollback ==="
ejecutar "$APP_DIR" rollback --all

echo
echo "=== 6. estado final ==="
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$TEST_DB" \
  -c 'SELECT count(*) AS sondas FROM "psc_seed_probe"'
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$TEST_DB" \
  -c 'SELECT count(*) AS ledger FROM "SeedExecution"'

echo
echo "CLI OK"
