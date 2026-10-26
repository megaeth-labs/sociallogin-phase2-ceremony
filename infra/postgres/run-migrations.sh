#!/bin/sh
set -eu

: "${PGHOST:?PGHOST is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"

psql --set ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS infra_schema_migrations (
  migration_name text PRIMARY KEY,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

for migration in /migrations/*.sql; do
  name=$(basename "$migration")
  case "$name" in
    *[!A-Za-z0-9._-]*) echo "unsafe migration filename: $name" >&2; exit 1 ;;
  esac
  checksum=$(sha256sum "$migration" | awk '{print $1}')
  recorded=$(psql --tuples-only --no-align \
    -c "SELECT sha256 FROM infra_schema_migrations WHERE migration_name = '$name'")

  if [ -n "$recorded" ]; then
    if [ "$recorded" != "$checksum" ]; then
      echo "applied migration $name differs from the checked-in file" >&2
      exit 1
    fi
    continue
  fi

  psql --set ON_ERROR_STOP=1 --file "$migration"
  psql --set ON_ERROR_STOP=1 \
    -c "INSERT INTO infra_schema_migrations (migration_name, sha256) VALUES ('$name', '$checksum')"
done
