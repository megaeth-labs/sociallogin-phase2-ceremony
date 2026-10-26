#!/bin/sh
# Contribute to the MOSS social login Phase 2 ceremony with the CLI built from
# this repository. Extra arguments are passed to the CLI.
set -eu
cd "$(dirname "$0")"
CLI=packages/cli/dist/index.js
ROOT_KEY=ceremonies/moss-social-login-phase2/manifest-root.pub
if [ ! -f "$CLI" ]; then
  echo "Build the CLI first:" >&2
  echo '  pnpm install --frozen-lockfile && pnpm --filter "@moss/phase2-ceremony-cli..." build' >&2
  exit 1
fi
node --input-type=module -e '
import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
const [cli, rootKey] = process.argv.slice(1);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
console.log("CLI SHA-256:           " + sha256(readFileSync(cli)));
console.log("Root key SPKI SHA-256: " + sha256(createPublicKey(readFileSync(rootKey)).export({ type: "spki", format: "der" })));
' "$CLI" "$ROOT_KEY"
exec node "$CLI" contribute https://dy87eh5gw5.execute-api.us-east-2.amazonaws.com \
  --slug moss-social-login-phase2 \
  --manifest-root-key "$ROOT_KEY" \
  --auth-url https://ceremony.megaeth.com \
  "$@"
