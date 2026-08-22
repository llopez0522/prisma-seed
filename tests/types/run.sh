#!/usr/bin/env bash
#
# Comprobaciones de tipos contra clientes REALES.
#
#   ./tests/types/run.sh
#
# Van aparte de `npm run typecheck` porque necesitan clientes generados que no
# existen en la raiz del repositorio:
#
#   Prisma     -> el cliente generado del fixture .fixtures/pg-cjs
#   ZenStack   -> el proyecto consumidor; lo ejecuta
#                 tests/integration/zenstack-v3/run.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "--- Prisma: SeedClient contra el PrismaClient generado del fixture ---"
docker compose run --rm dev npx tsc -p tests/types/tsconfig.prisma.json
echo "OK: PrismaClient real es asignable a SeedClient"
