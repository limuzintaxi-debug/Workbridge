import crypto from 'node:crypto';

const TTL_MS = 1000 * 60 * 60 * 24 * 7;
const COOKIE = 'wb_session';

const secret =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16
    ? process.env.SESSION_SECRET
    : crypto.randomBytes(32).toString('hex');

if (!process.env.SESSION_SECRET) {
  console.warn(
    '[workbridge] SESSION_SECRET is not set — using a random secret, sessions will reset on restart.'
  );
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === candidate.length && crypto.timingSafeEqual(known, candidate);
}

export function signSession(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TTL_MS })).toString(
    'base64url'
  );
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key) out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function setSessionCookie(req, res, user) {
  const token = signSession({ uid: user.id, role: user.role });
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: TTL_MS
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'unauthorized', message: 'Please sign in to continue.' });
    }
    if (roles.length && !roles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ error: 'forbidden', message: 'Your account does not have access to this action.' });
    }
    return next();
  };
}

export const SESSION_COOKIE = COOKIE;
