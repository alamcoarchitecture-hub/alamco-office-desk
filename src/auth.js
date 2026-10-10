const crypto = require('crypto');

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pin), salt, 32);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPin(pin, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [kind, saltHex, hashHex] = stored.split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const h = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), 32);
  const want = Buffer.from(hashHex, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const validPin = (p) => typeof p === 'string' && /^\d{4,8}$/.test(p);

// Stateless signed session cookie: base64url(json).hmac
function makeSession(secret, staffId, ttlMs) {
  const body = Buffer.from(JSON.stringify({ sid: staffId, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function readSession(secret, token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return d && d.exp > Date.now() && d.sid ? d : null;
  } catch (_) { return null; }
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// Tiny in-memory failure limiter.
function makeLimiter(max, windowMs) {
  const m = new Map();
  return {
    blocked(key) { const e = m.get(key); return !!(e && e.reset > Date.now() && e.n >= max); },
    fail(key) {
      const now = Date.now();
      const e = m.get(key);
      if (!e || e.reset <= now) m.set(key, { n: 1, reset: now + windowMs }); else e.n++;
      if (m.size > 5000) m.clear();
    },
    clear(key) { m.delete(key); },
  };
}

module.exports = { hashPin, verifyPin, safeEqual, validPin, makeSession, readSession, parseCookies, makeLimiter };
