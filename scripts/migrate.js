import fs from 'node:fs';
import pg from 'pg';
import { fileURLToPath } from 'node:url';

const schemaPath = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
const migDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
export function sslOpt() { return process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined; }

export async function migrate({ reset = false } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const c = new pg.Client({ connectionString: url, ssl: sslOpt() });
  await c.connect();
  try {
    if (reset) {
      if (!/test/i.test(new URL(url).pathname)) throw new Error('refusing to reset a database whose name does not contain "test"');
      await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }
    await c.query('SELECT pg_advisory_lock(727274)'); // several services may start at once
    const { rows } = await c.query("SELECT to_regclass('public.schema_meta') AS t");
    if (!rows[0].t) { await c.query(fs.readFileSync(schemaPath, 'utf8')); console.log('base schema applied'); }
    await c.query('CREATE TABLE IF NOT EXISTS applied_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
      if ((await c.query('SELECT 1 FROM applied_migrations WHERE name=$1', [f])).rowCount) continue;
      await c.query('BEGIN');
      try { await c.query(fs.readFileSync(migDir + f, 'utf8')); await c.query('INSERT INTO applied_migrations (name) VALUES ($1)', [f]); await c.query('COMMIT'); }
      catch (e) { await c.query('ROLLBACK'); throw e; }
      console.log('migration applied:', f);
    }
  } finally { await c.end(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate({ reset: process.argv.includes('--reset') }).catch((e) => { console.error(e.message); process.exit(1); });
}
