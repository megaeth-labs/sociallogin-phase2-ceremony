import Fastify from "fastify";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";

/** Deliberately separate from ceremony routes and schedule maintenance. */
export function buildReviewServer(checkDatabase: () => Promise<void>) {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (_request, reply) => { reply.header("cache-control", "no-store"); });
  app.get("/healthz", async () => ({ ok: true, mode: "review", contributionsEnabled: false }));
  app.get("/v1/rehearsal/setup", async (_request, reply) => {
    try {
      await checkDatabase();
      return { mode: "review", database: "ready", contributionsEnabled: false, schedule: null, beacon: null };
    } catch {
      return reply.code(503).send({ mode: "review", database: "unavailable", contributionsEnabled: false, schedule: null, beacon: null });
    }
  });
  app.setNotFoundHandler(async (_request, reply) => reply.code(423).send({ error: "Rehearsal is closed for flow review. Contributions are disabled." }));
  return app;
}

export async function startReviewFromEnvironment() {
  if (process.env.CEREMONY_MODE !== "rehearsal" || process.env.ALLOW_CEREMONY_INITIALIZATION === "true") {
    throw new Error("review mode requires rehearsal with initialization disabled");
  }
  const databaseUrl = process.env.DATABASE_URL;
  const caFile = process.env.DATABASE_CA_FILE;
  if (!databaseUrl || !caFile) throw new Error("review database configuration missing");
  const parsed = new URL(databaseUrl);
  if ([...parsed.searchParams.keys()].some(key => key.toLowerCase().startsWith("ssl"))) throw new Error("TLS query overrides forbidden");
  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000,
    query_timeout: 5000, ssl: { rejectUnauthorized: true, ca: await readFile(caFile, "utf8") } });
  const app = buildReviewServer(async () => { await pool.query("SELECT 1"); });
  app.addHook("onClose", async () => { await pool.end(); });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void app.close(); });
  await app.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 8787) });
}
