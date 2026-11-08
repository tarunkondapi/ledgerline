import pg from 'pg';
import { sslOpt } from '../scripts/migrate.js';

// BIGINT (20) and NUMERIC (1700) arrive as JS numbers. All amounts are capped far below 2^53 (see MAX_AMOUNT),
// and the balance_range CHECK keeps stored balances inside the safe-integer range.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export function makePool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslOpt(),
    max: Number(process.env.PGPOOL || 20),
  });
}
