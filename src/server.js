const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Store } = require('./store');
const A = require('./auth');
const P = require('./pipeline');
const J = require('./jobs');
const notify = require('./notify');

const SESSION_TTL = 7 * 24 * 3600 * 1000;
const COOKIE = 'desk_sid';

const dataDir = () => process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// createApp({ store }) accepts a pre-opened store (needed for Postgres, which loads asynchronously).
function createApp(opts = {}) {
  const store = opts.store || new Store(dataDir());
  let sessionSecret = process.env.DESK_SESSION_SECRET;
  if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[warn] DESK_SESSION_SECRET not set: using a random one (logins reset on every restart).');
  }
  const ownerPin = process.env.DESK_OWNER_PIN || '';
  if (!ownerPin) console.warn('[warn] DESK_OWNER_PIN not set: owner login is DISABLED.');
  if (!process.env.DESK_INGEST_SECRET) console.warn('[warn] DESK_INGEST_SECRET not set: /api/ingest is DISABLED.');

  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.use((err, _req, res, next) => (err ? res.status(400).json({ ok: false, error: 'bad json' }) : next()));

  // Cross-site write protection: SameSite=Lax cookie + JSON-only bodies + Origin check when present.
  app.use((req, res, next) => {
    if (!['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method) || !req.path.startsWith('/api/')) return next();
    const origin = req.get('origin');
    if (origin) { try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ ok: false, error: 'bad origin' }); } catch (_) { return res.status(403).json({ ok: false, error: 'bad origin' }); } }
    next();
  });

  const loginLimitIp = A.makeLimiter(30, 15 * 60 * 1000);
  const loginLimitUser = A.makeLimiter(5, 15 * 60 * 1000);

  // ---- session middleware ----
  app.use((req, _res, next) => {
    const s = A.readSession(sessionSecret, A.parseCookies(req.get('cookie'))[COOKIE]);
    req.user = s ? store.staffById(s.sid) : null;
    next();
  });
  const need = (req, res, next) => (req.user ? next() : res.status(401).json({ ok: false, error: 'login required' }));
  const needOwner = (req, res, next) => (req.user && req.user.role === 'owner' ? next() : res.status(req.user ? 403 : 401).json({ ok: false, error: 'owner only' }));
  const hasIngestSecret = (req) => {
    const s = process.env.DESK_INGEST_SECRET;
    if (!s) return false;
    const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.get('x-webhook-secret') || '';
    return !!given && A.safeEqual(given, s);
  };

  const pubStaff = (s, full) => ({ id: s.id, name: s.name, role: s.role, has_pin: s.id === 'owner' ? !!ownerPin : !!s.pin_hash, ...(full ? { telegram_chat_id: s.telegram_chat_id || '' } : {}) });
  const persistAndNotify = (messages) => {
    store.save();
    for (const m of messages || []) {
      const p = m.to === 'owner' ? notify.toOwner(m.text, m.tag) : notify.toStaff(m.to, m.text, m.tag);
      p.catch((e) => console.error('[notify] error', e.message));
    }
  };

  // ---- public ----
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'alamco-office-desk', dryRun: notify.isDryRun() }));
  app.get('/api/meta', (_req, res) => res.json({ stages: P.STAGES, roles: P.ROLES, role_labels: P.ROLE_LABELS, actions: Object.fromEntries(Object.entries(P.ACTIONS).map(([k, v]) => [k, { en: v.en }])) }));
  app.get('/api/login-options', (_req, res) => res.json({ staff: store.staff.map((s) => ({ id: s.id, name: s.name, role: s.role })) }));

  app.post('/api/login', (req, res) => {
    const ip = req.ip || '?';
    const id = String((req.body && req.body.staff_id) || '');
    const pin = String((req.body && req.body.pin) || '');
    if (loginLimitIp.blocked(ip) || loginLimitUser.blocked(id)) return res.status(429).json({ ok: false, error: 'too many attempts, try later' });
    const s = store.staffById(id);
    let ok = false;
    if (s) ok = s.id === 'owner' ? !!ownerPin && A.safeEqual(pin, ownerPin) : A.verifyPin(pin, s.pin_hash);
    if (!ok) { loginLimitIp.fail(ip); loginLimitUser.fail(id); return res.status(401).json({ ok: false, error: 'wrong PIN' }); }
    loginLimitUser.clear(id);
    const secure = process.env.NODE_ENV === 'production' || req.secure;
    res.append('Set-Cookie', `${COOKIE}=${A.makeSession(sessionSecret, s.id, SESSION_TTL)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}${secure ? '; Secure' : ''}`);
    res.json({ ok: true, user: pubStaff(s) });
  });
  app.post('/api/logout', (_req, res) => {
    res.append('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });
  app.get('/api/me', (req, res) => (req.user ? res.json({ ok: true, user: pubStaff(req.user) }) : res.status(401).json({ ok: false })));

  // ---- ingest (website webhook -> desk) ----
  app.post('/api/ingest', (req, res) => {
    if (!process.env.DESK_INGEST_SECRET) return res.status(503).json({ ok: false, error: 'ingest disabled (DESK_INGEST_SECRET not set)' });
    if (!hasIngestSecret(req)) return res.status(401).json({ ok: false, error: 'bad secret' });
    const r = J.ingest(store, req.body);
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    const msgs = [];
    if (r.created && process.env.NOTIFY_OWNER_ON_INGEST === '1') msgs.push({ to: 'owner', tag: 'ingest', text: `🆕 Office Desk: new job ${r.job.job_id}${r.job.client_name ? ' — ' + r.job.client_name : ''}` });
    if (r.changed) persistAndNotify(msgs);
    res.json({ ok: true, created: r.created, changed: r.changed, job_id: r.job.job_id, stage: r.job.stage });
  });

  // ---- jobs ----
  app.get('/api/jobs', need, (req, res) => {
    const list = [...store.jobs.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((j) => J.view(store, j, req.user));
    res.json({ ok: true, jobs: list });
  });
  app.get('/api/jobs/:id', need, (req, res) => {
    const j = store.jobs.get(req.params.id);
    return j ? res.json({ ok: true, job: J.view(store, j, req.user) }) : res.status(404).json({ ok: false, error: 'not found' });
  });
  app.post('/api/jobs/:id/actions', need, (req, res) => {
    const job = store.jobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'not found' });
    const r = J.act(store, req.user, job, req.body || {});
    if (r.error) return res.status(r.status || 400).json({ ok: false, error: r.error });
    persistAndNotify(r.messages);
    res.json({ ok: true, job: J.view(store, job, req.user) });
  });
  app.get('/api/my-work', need, (req, res) => {
    const u = req.user;
    const mine = [...store.jobs.values()].filter((j) => j.drafter_id === u.id || j.surveyor_id === u.id).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((j) => J.view(store, j, u));
    res.json({ ok: true, user: pubStaff(u), pending: J.pendingFor(store, u), jobs: mine });
  });

  // ---- summary: session (role-filtered) or ingest secret (full, for cron) ----
  app.get('/api/summary', (req, res) => {
    const actor = req.user || (hasIngestSecret(req) ? store.staffById('owner') : null);
    if (!actor) return res.status(401).json({ ok: false, error: 'login or secret required' });
    res.json({ ok: true, ...J.summary(store, actor) });
  });
  app.post('/api/summary/send', (req, res) => {
    const actor = req.user && req.user.role === 'owner' ? req.user : (hasIngestSecret(req) ? store.staffById('owner') : null);
    if (!actor) return res.status(401).json({ ok: false, error: 'owner login or secret required' });
    const s = J.summary(store, actor);
    notify.toOwner(s.text, 'summary').then((r) => res.json({ ok: true, dryRun: !!r.dryRun, pending_count: s.pending_count }));
  });

  // ---- team (owner) ----
  app.get('/api/staff', need, (req, res) => {
    const full = req.user.role === 'owner';
    const list = req.user.role === 'owner' || req.user.role === 'senior_architect' ? store.staff : store.staff.filter((s) => s.id === req.user.id);
    res.json({ ok: true, staff: list.map((s) => pubStaff(s, full)) });
  });
  const cleanStaff = (b, partial) => {
    const out = {};
    if (!partial || b.name !== undefined) { const n = String(b.name || '').trim().slice(0, 80); if (!n) return { error: 'name required' }; out.name = n; }
    if (!partial || b.role !== undefined) { if (!P.ROLES.includes(b.role) || b.role === 'owner') return { error: 'role must be senior_architect, drafter or surveyor' }; out.role = b.role; }
    if (b.telegram_chat_id !== undefined) { const c = String(b.telegram_chat_id || '').trim(); if (c && !/^-?\d{3,20}$/.test(c)) return { error: 'telegram_chat_id must be numeric' }; out.telegram_chat_id = c; }
    if (b.pin !== undefined && b.pin !== '') { if (!A.validPin(String(b.pin))) return { error: 'PIN must be 4-8 digits' }; out.pin_hash = A.hashPin(String(b.pin)); }
    return { out };
  };
  app.post('/api/staff', needOwner, (req, res) => {
    const c = cleanStaff(req.body || {}, false);
    if (c.error) return res.status(400).json({ ok: false, error: c.error });
    const s = { id: store.newId(), telegram_chat_id: '', pin_hash: '', ...c.out };
    store.staff.push(s); store.save();
    res.json({ ok: true, staff: pubStaff(s, true) });
  });
  app.patch('/api/staff/:id', needOwner, (req, res) => {
    const s = store.staffById(req.params.id);
    if (!s) return res.status(404).json({ ok: false, error: 'not found' });
    const b = { ...(req.body || {}) };
    if (s.id === 'owner') { delete b.role; delete b.pin; }
    const c = cleanStaff(b, true);
    if (c.error) return res.status(400).json({ ok: false, error: c.error });
    Object.assign(s, c.out); store.save();
    res.json({ ok: true, staff: pubStaff(s, true) });
  });
  app.delete('/api/staff/:id', needOwner, (req, res) => {
    const s = store.staffById(req.params.id);
    if (!s || s.id === 'owner') return res.status(s ? 400 : 404).json({ ok: false, error: s ? 'owner cannot be removed' : 'not found' });
    store.staff = store.staff.filter((x) => x.id !== s.id);
    for (const j of store.jobs.values()) {
      for (const k of ['drafter_id', 'surveyor_id']) if (j[k] === s.id) { j[k] = ''; j.history.push({ at: new Date().toISOString(), by: { id: req.user.id, name: req.user.name, role: 'owner' }, action: 'unassigned', detail: `${s.name} removed from team` }); }
    }
    store.save();
    res.json({ ok: true });
  });

  // ---- dry-run only: inspect what would have been sent (owner) ----
  app.get('/api/debug/outbox', needOwner, (_req, res) => {
    if (!notify.isDryRun()) return res.status(404).json({ ok: false });
    res.json({ ok: true, outbox: notify.outbox });
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0 }));
  app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'not found' }));
  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 3100;
  (async () => {
    const store = await Store.open({ dir: dataDir() });
    console.log(`storage: ${store.pgPool ? 'postgres (DATABASE_URL)' : 'json file (' + store.file + ')'}`);
    const server = createApp({ store }).listen(port, () => console.log(`alamco-office-desk listening on :${port} | dryRun=${notify.isDryRun()}`));
    const stop = () => { server.close(); store.close().catch(() => {}).finally(() => process.exit(0)); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  })().catch((e) => { console.error('[fatal] startup failed:', e.message); process.exit(1); });
}
module.exports = { createApp };
