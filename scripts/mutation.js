// Mutation check: break one safeguard at a time and prove the test suite FAILS. Restores the file afterwards.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const FILE = 'src/money.js';
const original = fs.readFileSync(FILE, 'utf8');
const mutations = [
  { name: 'remove the row lock (FOR UPDATE)', from: 'FOR UPDATE /*M:LOCK*/', to: '/*M:LOCK*/' },
  { name: 'remove the application balance-floor check', from: '/*M:FLOOR*/', to: 'false &&' },
  { name: 'replace insert-first idempotency claim with one that always "wins"',
    from: 'ON CONFLICT (user_id, key) DO NOTHING /*M:IDEM*/', to: 'ON CONFLICT (user_id, key) DO UPDATE SET status = idempotency_keys.status /*M:IDEM*/' },
  { name: 'remove ascending-id lock ordering (deadlock retry alone must not hide it)',
    from: 'for (const id of [...new Set(ids)].sort((a, b) => a - b))', to: 'for (const id of [...new Set(ids)])' },
];
let survived = 0;
try {
  for (const m of mutations) {
    if (!original.includes(m.from)) throw new Error(`mutation anchor not found: ${m.name}`);
    fs.writeFileSync(FILE, original.replace(m.from, m.to));
    const r = spawnSync(process.execPath, ['scripts/run-tests.js'], { encoding: 'utf8', env: process.env, timeout: 280000 });
    const caught = r.status !== 0;
    if (!caught) survived++;
    console.log(`${caught ? 'CAUGHT  ' : 'SURVIVED'}  ${m.name}`);
  }
} finally { fs.writeFileSync(FILE, original); }
console.log(survived === 0 ? '\nAll mutations were caught by the test suite.' : `\n${survived} mutation(s) SURVIVED: tests are too weak.`);
process.exit(survived ? 1 : 0);
