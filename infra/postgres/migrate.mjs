// One-shot deployment task. Master credentials exist only in this process;
// the coordinator receives a distinct non-superuser connection string.
import { Client } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
let db;
try {
  const admin = JSON.parse(process.env.DATABASE_ADMIN_SECRET);
  const config = JSON.parse(process.env.CEREMONY_RUNTIME_CONFIG);
  delete process.env.DATABASE_ADMIN_SECRET;
  delete process.env.CEREMONY_RUNTIME_CONFIG;
  const url = new URL(config.environment.DATABASE_URL);
  if (url.username !== 'ceremonyapp' || !url.password || url.search) throw new Error('invalid app connection');
  db = new Client({ host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1),
    user: admin.username, password: admin.password, connectionTimeoutMillis: 15000,
    ssl: { rejectUnauthorized: true, ca: config.files.DATABASE_CA_FILE } });
  await db.connect();
  await db.query('SELECT pg_advisory_lock(58423017)');
  await db.query('CREATE TABLE IF NOT EXISTS infra_schema_migrations (migration_name text PRIMARY KEY, sha256 char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of (await readdir('/app/migrations')).filter(n => /^[0-9]+_[a-z_]+\.sql$/.test(n)).sort()) {
    const sql = await readFile(`/app/migrations/${name}`, 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    const prior = await db.query('SELECT sha256 FROM infra_schema_migrations WHERE migration_name=$1', [name]);
    if (prior.rows.length) { if (prior.rows[0].sha256 !== hash) throw new Error('migration drift'); continue; }
    await db.query('BEGIN');
    try {
      await db.query(sql.replace(/^\s*BEGIN;\s*/i, '').replace(/\s*COMMIT;\s*$/i, ''));
      await db.query('INSERT INTO infra_schema_migrations (migration_name,sha256) VALUES ($1,$2)', [name,hash]);
      await db.query('COMMIT');
    } catch { await db.query('ROLLBACK'); throw new Error('migration failed'); }
  }
  const role = await db.query("SELECT 1 FROM pg_roles WHERE rolname='ceremonyapp'");
  if (!role.rows.length) await db.query('CREATE ROLE ceremonyapp LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');
  const password = decodeURIComponent(url.password);
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(password)) throw new Error('invalid generated password');
  await db.query(`ALTER ROLE ceremonyapp PASSWORD '${password}'`);
  await db.query('GRANT CONNECT ON DATABASE ceremony TO ceremonyapp');
  await db.query('GRANT USAGE ON SCHEMA public TO ceremonyapp');
  await db.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ceremonyapp');
  await db.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ceremonyapp');
  await db.query('REVOKE ALL ON infra_schema_migrations FROM ceremonyapp');
  console.log('Schema migrations and scoped application role ready; no ceremony initialized.');
} catch { console.error('Migration task failed; no private diagnostics emitted.'); process.exitCode = 1; }
finally { await db?.end().catch(() => {}); }
