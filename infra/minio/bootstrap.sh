#!/bin/sh
set -eu

: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
: "${MINIO_COORDINATOR_ACCESS_KEY:?MINIO_COORDINATOR_ACCESS_KEY is required}"
: "${MINIO_COORDINATOR_SECRET_KEY:?MINIO_COORDINATOR_SECRET_KEY is required}"
: "${MINIO_VERIFIER_ACCESS_KEY:?MINIO_VERIFIER_ACCESS_KEY is required}"
: "${MINIO_VERIFIER_SECRET_KEY:?MINIO_VERIFIER_SECRET_KEY is required}"

alias_name=local
endpoint=http://minio:9000

until mc alias set "$alias_name" "$endpoint" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
  sleep 1
done

# Optional policy emulator only: no concrete coordinator S3 runtime is wired to
# this bucket. These prefixes model a possible quarantine/archive split for
# local experiments. Production must use distinct buckets/accounts as required
# by the deployment checklist and validate the actual provider integration.
mc mb --ignore-existing --with-lock "$alias_name/moss-phase2-artifacts"
mc version enable "$alias_name/moss-phase2-artifacts"
mc retention set --default COMPLIANCE 30d "$alias_name/moss-phase2-artifacts"

mc admin policy create "$alias_name" moss-phase2-coordinator /policies/coordinator-policy.json >/dev/null
mc admin policy create "$alias_name" moss-phase2-verifier /policies/verifier-policy.json >/dev/null

if ! mc admin user info "$alias_name" "$MINIO_COORDINATOR_ACCESS_KEY" >/dev/null 2>&1; then
  mc admin user add "$alias_name" "$MINIO_COORDINATOR_ACCESS_KEY" "$MINIO_COORDINATOR_SECRET_KEY" >/dev/null
fi
if ! mc admin user info "$alias_name" "$MINIO_VERIFIER_ACCESS_KEY" >/dev/null 2>&1; then
  mc admin user add "$alias_name" "$MINIO_VERIFIER_ACCESS_KEY" "$MINIO_VERIFIER_SECRET_KEY" >/dev/null
fi
mc admin policy attach "$alias_name" moss-phase2-coordinator --user "$MINIO_COORDINATOR_ACCESS_KEY" >/dev/null
mc admin policy attach "$alias_name" moss-phase2-verifier --user "$MINIO_VERIFIER_ACCESS_KEY" >/dev/null

# Fail closed when a reused volume contains service users with credentials that
# no longer match the compose variables.
mc alias set coordinator-check "$endpoint" "$MINIO_COORDINATOR_ACCESS_KEY" "$MINIO_COORDINATOR_SECRET_KEY" >/dev/null
mc alias set verifier-check "$endpoint" "$MINIO_VERIFIER_ACCESS_KEY" "$MINIO_VERIFIER_SECRET_KEY" >/dev/null
mc ls coordinator-check/moss-phase2-artifacts >/dev/null
mc ls verifier-check/moss-phase2-artifacts >/dev/null

# Incomplete multipart uploads are untrusted, billable input. Keep the local
# cleanup window short; production should also abort each expired lease eagerly.
mc ilm rule add --abort-incomplete-multipart-upload-days 1 "$alias_name/moss-phase2-artifacts" >/dev/null 2>&1 || true

mc ready "$alias_name" >/dev/null
