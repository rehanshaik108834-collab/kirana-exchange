#!/bin/bash
# Runs once, on an empty data volume, from /docker-entrypoint-initdb.d.
# Creates the 10 isolated logical databases (ADR-002) and their extensions only.
# Tables are owned by each service's TypeORM migrations (migrationsRun: true);
# the Phase 2 reference DDL lives in docs/sql/01-schemas.sql and is NOT executed here.
set -euo pipefail

DATABASES=(auth_db shop_db catalog_db inventory_db forecast_db swap_db saga_db groupbuy_db notify_db analytics_db)

for db in "${DATABASES[@]}"; do
  echo "Creating database: $db"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -c "CREATE DATABASE \"$db\";"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" \
    -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'
done

# Trigram GIN search on product names (catalog-service).
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname catalog_db \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'

echo "All ${#DATABASES[@]} databases created."
