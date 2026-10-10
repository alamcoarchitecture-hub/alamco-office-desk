// JSON-file storage with atomic writes. Single process only (see README limitations).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEED_STAFF = [
  { name: 'Senior Architect (placeholder)', role: 'senior_architect' },
  { name: 'Drafter 1 (placeholder)', role: 'drafter' },
  { name: 'Surveyor 1 (placeholder)', role: 'surveyor' },
];
const newId = () => crypto.randomBytes(6).toString('hex');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(dir, { recursive: true });
    let data = { staff: [], jobs: [] };
    try { data = { ...data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch (_) {}
    this.staff = data.staff;
    this.jobs = new Map(data.jobs.map((j) => [j.job_id, j]));
    let dirty = false;
    if (!this.staff.some((s) => s.id === 'owner')) {
      this.staff.unshift({ id: 'owner', name: 'Owner', role: 'owner', telegram_chat_id: '', pin_hash: '' });
      dirty = true;
    }
    if (this.staff.length === 1) {
      SEED_STAFF.forEach((s) => this.staff.push({ id: newId(), ...s, telegram_chat_id: '', pin_hash: '' }));
      dirty = true;
    }
    if (dirty) this.save();
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ staff: this.staff, jobs: [...this.jobs.values()] }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  staffById(id) { return this.staff.find((s) => s.id === id) || null; }
  newId() { return newId(); }
}
module.exports = { Store };
