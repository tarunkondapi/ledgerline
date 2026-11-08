import express from 'express';
import { makePool } from './db.js';
import { createApp } from './app.js';

const pool = makePool();
const servers = [];
const note = (name, url) => console.log(`LedgerLine ${name.padEnd(8)} → ${url}`);

if (process.env.PORT || process.env.SINGLE_PORT === 'true') {
  // Hosting platforms expose ONE port: mount the three portals by path. Each is still a separate app with its own
  // API allowlist and token audience, so a holder token is useless on /admin and /auditor.
  const port = Number(process.env.PORT || 3000), root = express();
  root.disable('x-powered-by'); root.set('strict routing', true); // '/admin' redirects to '/admin/'; '/admin/' must not match that route
    // Render's health check hits /api/health on the ROOT; without this it 404s and the deploy is marked failed.
  root.get('/api/health', async (_q, r) => { try { await pool.query('SELECT 1'); r.json({ ok: true }); } catch { r.status(503).json({ ok: false }); } });
<body style="font:17px Georgia,serif;max-width:520px;margin:12vh auto;padding:0 20px"><h1>LedgerLine</h1><p>Money movement with a ledger you can prove. Choose a portal:</p>
<p><a href=/holder/>Customer portal</a> · <a href=/admin/>Admin console</a> · <a href=/auditor/>Audit desk</a></p></body>`));
  for (const p of ['holder', 'admin', 'auditor']) {
    root.get('/' + p, (_q, r) => r.redirect(`/${p}/`));
    root.use('/' + p, createApp(pool, p, { base: '/' + p }));
  }
  servers.push(root.listen(port, '0.0.0.0', () => note('all', `http://localhost:${port}`)));
} else {
  // Local / self-hosted: three listeners on three ports. Admin and auditor bind to localhost by default.
  const l = (portal, port, host) => servers.push(createApp(pool, portal).listen(port, host, () => note(portal, `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`)));
  l('holder', Number(process.env.HOLDER_PORT || 3000), process.env.HOLDER_HOST || '0.0.0.0');
  l('admin', Number(process.env.ADMIN_PORT || 3001), process.env.ADMIN_HOST || '127.0.0.1');
  l('auditor', Number(process.env.AUDITOR_PORT || 3002), process.env.AUDITOR_HOST || '127.0.0.1');
}
const stop = () => { servers.forEach((s) => s.close()); pool.end().then(() => process.exit(0)); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
