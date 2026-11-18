#!/bin/bash
set -e

DATABASES=("auth_db" "shop_db" "catalog_db" "inventory_db" "forecast_db" "swap_db" "saga_db" "groupbuy_db" "notify_db" "analytics_db")

for db in "${DATABASES[@]}"; do
  echo "Creating database: $db"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "postgres" <<-EOSQL
      CREATE DATABASE $db;
EOSQL

  # Connect to the newly created database and run the shared extensions/tables
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-EOSQL
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
EOSQL
done

echo "Databases created successfully."
