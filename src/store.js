// Storage: JSON file (default) or PostgreSQL (when DATABASE_URL is set).
// The whole state lives in memory (same sync interface either way); save() persists it.
//  - JSON backend: atomic write (tmp + rename), synchronous.
//  - Postgres backend: table desk_state(key, value jsonb, updated_at); save() snapshots the state
//    synchronously and writes snapshots strictly one at a time, in order (no lost updates; bursts coalesce).
//    Single process only (state is cached in memory).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEED_STAFF = [
  { name: 'Senior Architect (placeholder)', role: 'senior_architect' },
  { name: 'Drafter 1 (placeholder)', role: 'drafter' },
  { name: 'Surveyor 1 (placeholder)', role: 'surveyor' },
];
function makePool(url) {
  const { Pool } = require('pg'); // lazy: only needed when DATABASE_URL is set
  let local = false;
  let conn = url;
  try {
    const u = new URL(url);
    local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
    if (!local) { // our explicit ssl option must win over sslmode/ssl params in the URL
      ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert'].forEach((k) => u.searchParams.delete(k));
      conn = u.toString();
    }
  } catch (_) {}
  return new Pool({ connectionString: conn, max: 3, ...(local ? {} : { ssl: { rejectUnauthorized: false } }) });
}
const newId = () => crypto.randomBytes(6).toString('hex');

class Store {
  // Synchronous JSON-file store (default). For Postgres use `await Store.open()`.
  constructor(dir, preloaded) {
    this.dir = dir;
    this.pgPool = null;
    let data = { staff: [], jobs: [] };
    if (preloaded) {
      data = { ...data, ...preloaded };
    } else {
      this.file = path.join(dir, 'db.json');
      fs.mkdirSync(dir, { recursive: true });
      try { data = { ...data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch (_) {}
    }
    this.staff = data.staff;
    this.jobs = new Map(data.jobs.map((j) => [j.job_id, j]));
    this._chain = Promise.resolve();
    this._pending = null;
    this.dirty = false;
    if (!this.staff.some((s) => s.id === 'owner')) {
      this.staff.unshift({ id: 'owner', name: 'Owner', role: 'owner', telegram_chat_id: '', pin_hash: '' });
      this.dirty = true;
    }
    if (this.staff.length === 1) {
      SEED_STAFF.forEach((s) => this.staff.push({ id: newId(), ...s, telegram_chat_id: '', pin_hash: '' }));
      this.dirty = true;
    }
    if (this.dirty && !preloaded) this.save(); // Postgres: Store.open() saves after attaching the pool
  }

  // Async factory: Postgres if opts.databaseUrl (or env DATABASE_URL) is set, else JSON file in opts.dir.
  // opts.pool lets tests inject a pg-compatible pool.
  static async open(opts = {}) {
    const url = opts.databaseUrl !== undefined ? opts.databaseUrl : process.env.DATABASE_URL;
    if (!url && !opts.pool) return new Store(opts.dir);
    const pool = opts.pool || makePool(url);
    await pool.query('CREATE TABLE IF NOT EXISTS desk_state (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    const r = await pool.query("SELECT key, value FROM desk_state WHERE key IN ('staff','jobs')");
    const preloaded = {};
    for (const row of r.rows) preloaded[row.key] = row.value;
    const st = new Store(opts.dir, preloaded);
    st.pgPool = pool;
    if (st.dirty) st.save();
    return st;
  }

  save() {
    if (this.pgPool) return this._savePg();
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ staff: this.staff, jobs: [...this.jobs.values()] }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  _savePg() {
    // Snapshot now (sync) so later in-memory mutations cannot tear a write; keep only the newest pending snapshot.
    const snap = { staff: JSON.stringify(this.staff), jobs: JSON.stringify([...this.jobs.values()]) };
    const had = this._pending !== null;
    this._pending = snap;
    if (had) return this._chain; // a queued write will pick up the newest snapshot
    this._chain = this._chain.then(async () => {
      const cur = this._pending; this._pending = null;
      try {
        const c = await this.pgPool.connect();
        try {
          await c.query('BEGIN');
          for (const k of ['staff', 'jobs']) {
            await c.query('INSERT INTO desk_state (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', [k, cur[k]]);
          }
          await c.query('COMMIT');
        } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; } finally { c.release(); }
      } catch (e) { console.error('[store] postgres write failed:', e.message); }
    });
    return this._chain;
  }
  // Resolves when every save() issued so far has been written (no-op for JSON).
  async flush() { await this._chain; }
  async close() { await this.flush(); if (this.pgPool) await this.pgPool.end(); }
  staffById(id) { return this.staff.find((s) => s.id === id) || null; }
  newId() { return newId(); }
}
module.exports = { Store, makePool };
