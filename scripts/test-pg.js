// Proves the Postgres backend round-trips state. Uses pg-mem (in-memory Postgres emulator, dev-only);
// makes no network connections. Run: npm run test:pg
const assert = require('assert');
const { newDb } = require('pg-mem');
const { Store, makePool } = require('../src/store');
let n = 0;
const ok = (m) => console.log(`  ✓ ${++n}. ${m}`);

(async () => {
  const mem = new (newDb().adapters.createPg().Pool)();
  // pg-mem quirk: re-running CREATE TABLE IF NOT EXISTS on an existing table throws "Not supported"
  // (real Postgres just skips it). Emulate that skip so we can reopen the store on the same database.
  let created = false;
  const pool = {
    query: (sql, ...a) => (/^\s*CREATE TABLE IF NOT EXISTS/i.test(sql) && created ? Promise.resolve({ rows: [] }) : mem.query(sql, ...a).then((r) => { if (/^\s*CREATE TABLE/i.test(sql)) created = true; return r; })),
    connect: () => mem.connect(),
    end: () => mem.end(),
  };

  // 1. fresh DB: table auto-created, owner + placeholder staff seeded and persisted
  const a = await Store.open({ pool });
  await a.flush();
  assert.ok(a.pgPool, 'postgres backend active'); ok('Store.open uses Postgres when a pool is given');
  const t = await pool.query("select key from desk_state order by key");
  assert.deepStrictEqual(t.rows.map((r) => r.key), ['jobs', 'staff']); ok('desk_state table created with staff + jobs documents');
  assert.strictEqual(a.staff.length, 4); assert.strictEqual(a.staffById('owner').role, 'owner'); ok('owner + 3 placeholder staff seeded');

  // 2. mutate, save (many rapid saves, not awaited, like the app does) and reload from the DB
  const staffIds = a.staff.map((s) => s.id);
  for (let i = 0; i < 25; i++) {
    a.jobs.set('J' + i, { job_id: 'J' + i, stage: 'new', updated_at: new Date().toISOString(), note: 'മലയാളം ✓ ' + i });
    a.save();
  }
  a.staff.push({ id: 'x1', name: 'New Drafter', role: 'drafter', telegram_chat_id: '', pin_hash: 'h' }); a.save();
  a.jobs.get('J3').stage = 'verified'; a.save();
  await a.flush(); ok('25+ rapid un-awaited saves flushed');
  const b = await Store.open({ pool });
  assert.strictEqual(b.jobs.size, 25);
  assert.strictEqual(b.jobs.get('J3').stage, 'verified');
  assert.strictEqual(b.jobs.get('J24').note, 'മലയാളം ✓ 24');
  assert.deepStrictEqual(b.staff.map((s) => s.id), [...staffIds, 'x1']);
  assert.strictEqual(b.staffById('x1').pin_hash, 'h'); ok('state round-trips through a fresh Store (latest write wins, no lost updates)');

  // 3. no reseed / duplication on reopen
  assert.strictEqual(b.staff.length, 5); ok('reopen does not re-seed staff');

  // 4. interleaved writers on one store keep order: last snapshot is what is stored
  for (let i = 0; i < 10; i++) { b.jobs.get('J0').note = 'v' + i; b.save(); await new Promise((r) => setImmediate(r)); }
  await b.flush();
  const c = await Store.open({ pool });
  assert.strictEqual(c.jobs.get('J0').note, 'v9'); ok('ordered, serialized writes: final value persisted');

  // 5. a failed write is logged, does not wedge later writes
  const realConnect = pool.connect.bind(pool); let fail = true;
  const origErr = console.error; let logged = 0; console.error = () => { logged++; };
  c.pgPool = { connect: async () => { if (fail) { fail = false; throw new Error('boom'); } return realConnect(); } };
  c.jobs.get('J1').note = 'lost'; c.save(); await c.flush();
  c.jobs.get('J1').note = 'kept'; c.save(); await c.flush();
  console.error = origErr; c.pgPool = pool;
  assert.strictEqual(logged, 1);
  const d = await Store.open({ pool });
  assert.strictEqual(d.jobs.get('J1').note, 'kept'); ok('write failure is logged and later writes still succeed');

  // 6. SSL selection
  const sslOf = (u) => { const p = makePool(u); const s = p.options.ssl; p.end().catch(() => {}); return s; };
  assert.strictEqual(sslOf('postgres://u:p@localhost:5432/db'), undefined);
  assert.strictEqual(sslOf('postgres://u:p@127.0.0.1/db'), undefined);
  assert.deepStrictEqual(sslOf('postgres://u:p@ep-x.neon.tech/db?sslmode=require'), { rejectUnauthorized: false });
  assert.deepStrictEqual(sslOf('postgres://u:p@aws-0.pooler.supabase.com:6543/postgres'), { rejectUnauthorized: false });
  ok('SSL off for localhost, ssl {rejectUnauthorized:false} for remote hosts (even with sslmode in URL)');

  // 7. default is still the JSON backend
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-json-'));
  delete process.env.DATABASE_URL;
  const j = await Store.open({ dir });
  assert.ok(!j.pgPool && fs.existsSync(path.join(dir, 'db.json'))); fs.rmSync(dir, { recursive: true, force: true });
  ok('without DATABASE_URL the JSON-file backend is used');

  // 8. whole app on the Postgres store (HTTP), then restart from DB
  process.env.DESK_INGEST_SECRET = 's3'; process.env.DRY_RUN = '1'; process.env.DESK_OWNER_PIN = '1234'; process.env.DESK_SESSION_SECRET = 'x';
  const { createApp } = require('../src/server');
  const store = await Store.open({ pool });
  const srv = createApp({ store }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const r = await fetch(base + '/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer s3' }, body: JSON.stringify({ job_id: 'ALM-PG-1', status: 'new', client: { name: 'PG Client' } }) });
  assert.strictEqual(r.status, 200);
  await store.flush(); srv.close();
  const e = await Store.open({ pool });
  assert.ok(e.jobs.has('ALM-PG-1')); ok('job created via HTTP API is persisted in Postgres and reloads');
  console.log(`\nPG TESTS PASSED (${n})`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
