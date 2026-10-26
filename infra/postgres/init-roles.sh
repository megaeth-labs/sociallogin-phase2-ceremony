#!/bin/sh
set -eu

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${MOSS_COORDINATOR_DB_USER:?MOSS_COORDINATOR_DB_USER is required}"
: "${MOSS_COORDINATOR_DB_PASSWORD:?MOSS_COORDINATOR_DB_PASSWORD is required}"

case "$MOSS_COORDINATOR_DB_USER" in
  *[!A-Za-z0-9_]*) echo "coordinator database user must be alphanumeric/underscore" >&2; exit 1 ;;
esac

psql --set ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set coordinator_user="$MOSS_COORDINATOR_DB_USER" \
  --set coordinator_password="$MOSS_COORDINATOR_DB_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
  :'coordinator_user',
  :'coordinator_password'
) WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'coordinator_user'
) \gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
  :'coordinator_user',
  :'coordinator_password'
) \gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'coordinator_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'coordinator_user') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'coordinator_user') \gexec
SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'coordinator_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'coordinator_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', :'coordinator_user') \gexec
SQL
