import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { HttpError } from './errors.js';

const SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) throw new Error('JWT_SECRET must be set in production');
const DUMMY = bcrypt.hashSync('not-a-real-password', 10); // equalises timing for unknown emails

export const hashPassword = (pw) => bcrypt.hash(pw, 10);
const event = (pool, e) => pool.query('INSERT INTO auth_events (user_id, email, portal, outcome, ip) VALUES ($1,$2,$3,$4,$5)',
  [e.user_id ?? null, String(e.email ?? '').slice(0, 200), e.portal, e.outcome, e.ip ?? null]).catch(() => {});

/** portal: 'admin' | 'holder' | 'auditor' | 'all'. A portal only signs in users of its own role. Every attempt is logged. */
export async function login(pool, email, password, portal = 'all', ip = null) {
  if (typeof email !== 'string' || typeof password !== 'string') throw new HttpError(400, 'bad_request', 'email and password required');
  email = email.toLowerCase().trim();
  const { rows: [u] } = await pool.query('SELECT id, email, role, status, disabled, password_hash FROM users WHERE email = $1', [email]);
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY);
  if (!u || !ok) { await event(pool, { user_id: u?.id, email, portal, outcome: 'bad_credentials', ip }); throw new HttpError(401, 'invalid_credentials', 'Invalid email or password'); }
  if (u.status === 'pending') { await event(pool, { user_id: u.id, email, portal, outcome: 'disabled', ip }); throw new HttpError(403, 'pending_approval', 'Your application is awaiting administrator approval.'); }
  if (u.disabled || u.status !== 'active') { await event(pool, { user_id: u.id, email, portal, outcome: 'disabled', ip }); throw new HttpError(403, 'account_disabled', 'This user account is not active.'); }
  if (portal !== 'all' && u.role !== portal) { await event(pool, { user_id: u.id, email, portal, outcome: 'wrong_portal', ip }); throw new HttpError(403, 'wrong_portal', `This sign-in is for ${portal} users only. Use the ${u.role} portal.`); }
  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
  await event(pool, { user_id: u.id, email, portal, outcome: 'success', ip });
  return { token: jwt.sign({ sub: u.id, portal }, SECRET, { expiresIn: '1h' }), user: { id: u.id, email: u.email, role: u.role } };
}

/** Role/status are ALWAYS re-read from the database. A token only works on the portal that issued it,
 *  and never after the user is disabled or has changed their password since it was issued. */
export function authenticate(pool, portal = 'all') {
  return async (req, _res, next) => {
    try {
      const h = req.headers.authorization || '';
      if (!h.startsWith('Bearer ')) throw new HttpError(401, 'unauthenticated', 'Login required');
      let payload;
      try { payload = jwt.verify(h.slice(7), SECRET, { algorithms: ['HS256'] }); }
      catch { throw new HttpError(401, 'unauthenticated', 'Invalid or expired token'); }
      const { rows: [u] } = await pool.query('SELECT id, email, role, status, disabled, password_changed_at FROM users WHERE id = $1', [payload.sub]);
      if (!u || u.disabled || u.status !== 'active') throw new HttpError(401, 'unauthenticated', 'Unknown or inactive user');
      if (u.password_changed_at && payload.iat < Math.floor(new Date(u.password_changed_at).getTime() / 1000)) throw new HttpError(401, 'unauthenticated', 'Password changed: sign in again');
      if (portal !== 'all' && (payload.portal !== portal || u.role !== portal)) throw new HttpError(401, 'unauthenticated', 'Token not valid on this portal');
      req.user = { id: u.id, email: u.email, role: u.role };
      next();
    } catch (e) { next(e); }
  };
}

export async function changePassword(pool, user, portal, current, next) {
  if (typeof current !== 'string' || typeof next !== 'string') throw new HttpError(400, 'bad_request', 'current_password and new_password required');
  if (next.length < 8 || next.length > 100 || !/[A-Za-z]/.test(next) || !/\d/.test(next)) throw new HttpError(400, 'weak_password', 'New password needs 8+ characters with a letter and a digit');
  const { rows: [u] } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  if (!(await bcrypt.compare(current, u.password_hash))) throw new HttpError(401, 'invalid_credentials', 'Current password is incorrect');
  await pool.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [user.id, await hashPassword(next)]);
  await new Promise((r) => setTimeout(r, 1100)); // so the fresh token's iat is strictly after the change (iat has 1s resolution)
  return { token: jwt.sign({ sub: user.id, portal }, SECRET, { expiresIn: '1h' }) };
}

export const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(new HttpError(403, 'forbidden', `Requires role: ${roles.join(' or ')}`));
