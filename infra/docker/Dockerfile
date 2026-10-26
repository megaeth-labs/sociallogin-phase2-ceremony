# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim

FROM rust:1.85.1-bookworm AS bellman-build
WORKDIR /build
COPY packages/bellman-verify/Cargo.toml packages/bellman-verify/Cargo.lock ./
COPY packages/bellman-verify/src ./src
RUN cargo build --release --locked

FROM ${NODE_IMAGE} AS build

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /workspace

RUN corepack enable \
    && corepack prepare pnpm@10.29.2 --activate

# Copy manifests separately so dependency installation remains cacheable. Only
# the server-side workspace closure is included in these images.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json ./
COPY apps/witness/package.json apps/witness/tsconfig.json ./apps/witness/
COPY apps/coordinator/package.json apps/coordinator/tsconfig.json ./apps/coordinator/
COPY apps/verifier-worker/package.json apps/verifier-worker/tsconfig.json ./apps/verifier-worker/
COPY packages/db/package.json packages/db/tsconfig.json ./packages/db/
COPY packages/protocol/package.json packages/protocol/tsconfig.json ./packages/protocol/
COPY packages/storage/package.json packages/storage/tsconfig.json ./packages/storage/
COPY packages/zkey-inspect/package.json packages/zkey-inspect/tsconfig.json ./packages/zkey-inspect/

RUN --mount=type=cache,id=moss-phase2-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY apps/witness ./apps/witness
COPY apps/coordinator ./apps/coordinator
COPY apps/verifier-worker ./apps/verifier-worker
COPY packages/db ./packages/db
COPY packages/protocol ./packages/protocol
COPY packages/storage ./packages/storage
COPY packages/zkey-inspect ./packages/zkey-inspect

RUN pnpm --filter @moss/phase2-coordinator... build \
    && pnpm --filter @moss/phase2-verifier-worker... build \
    && pnpm --filter @moss/phase2-witness... build \
    && pnpm --filter @moss/phase2-coordinator --prod deploy --legacy /out/coordinator \
    && pnpm --filter @moss/phase2-verifier-worker --prod deploy --legacy /out/verifier-worker \
    && pnpm --filter @moss/phase2-witness --prod deploy --legacy /out/witness

FROM ${NODE_IMAGE} AS coordinator

ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps
WORKDIR /app
ENV TMPDIR=/scratch
RUN mkdir -p /scratch && chown node:node /scratch
VOLUME /scratch

COPY --from=build --chown=node:node /out/coordinator/package.json ./package.json
COPY --from=build --chown=node:node /out/coordinator/dist/ ./dist/
COPY --from=build --chown=node:node /out/coordinator/node_modules/ ./node_modules/

COPY --chown=node:node infra/docker/runtime-entry.mjs ./infra/runtime-entry.mjs
COPY --chown=node:node infra/postgres/migrate.mjs ./infra/migrate.mjs
COPY --chown=node:node packages/db/migrations ./migrations

USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]

FROM ${NODE_IMAGE} AS verifier-worker

COPY --from=bellman-build /build/target/release/moss-bellman-verify /usr/local/bin/moss-bellman-verify
ENV BELLMAN_VERIFIER_PATH=/usr/local/bin/moss-bellman-verify

ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps
WORKDIR /app
ENV TMPDIR=/scratch
RUN mkdir -p /scratch && chown node:node /scratch
VOLUME /scratch

COPY --from=build --chown=node:node /out/verifier-worker/package.json ./package.json
COPY --from=build --chown=node:node /out/verifier-worker/dist/ ./dist/
COPY --from=build --chown=node:node /out/verifier-worker/node_modules/ ./node_modules/

COPY --chown=node:node infra/docker/runtime-entry.mjs ./infra/runtime-entry.mjs

USER node
CMD ["node", "dist/main.js"]

FROM ${NODE_IMAGE} AS witness
ENV NODE_ENV=production
ENV TMPDIR=/scratch
WORKDIR /app
RUN mkdir -p /scratch && chown node:node /scratch
VOLUME /scratch
COPY --from=build --chown=node:node /out/witness/package.json ./package.json
COPY --from=build --chown=node:node /out/witness/dist/ ./dist/
COPY --from=build --chown=node:node /out/witness/node_modules/ ./node_modules/
COPY --chown=node:node infra/docker/runtime-entry.mjs ./infra/runtime-entry.mjs
USER node
EXPOSE 8787
CMD ["node", "infra/runtime-entry.mjs", "witness"]
