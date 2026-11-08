import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) {
  console.error('Set TEST_DATABASE_URL to a DEDICATED database whose name contains "test" (it is wiped on every run).');
  process.exit(2);
}
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=60000', ...fs.readdirSync('tests').filter((f) => f.endsWith('.test.js')).map((f) => 'tests/' + f)], { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } });
process.exit(r.status ?? 1);
