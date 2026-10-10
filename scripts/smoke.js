// End-to-end smoke test against a running desk (see smoke.sh).
const assert = require('assert');
const BASE = process.env.SMOKE_BASE;
const SECRET = 'smoke-ingest-secret';

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body, headers = {}) {
    const r = await fetch(BASE + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }
  async login(id, pin) { const r = await this.req('POST', '/api/login', { staff_id: id, pin }); assert.strictEqual(r.status, 200, 'login ' + JSON.stringify(r.body)); }
}
let n = 0;
const ok = (m) => console.log(`  ✓ ${++n}. ${m}`);

(async () => {
  const anon = new Client();
  const auth = { Authorization: 'Bearer ' + SECRET };

  // ingest auth
  let r = await anon.req('POST', '/api/ingest', { job_id: 'ALM-SMOKE-1' });
  assert.strictEqual(r.status, 401); ok('ingest rejects missing secret');
  r = await anon.req('POST', '/api/ingest', { client: { name: 'x' } }, auth);
  assert.strictEqual(r.status, 400); ok('ingest rejects payload without job_id');

  // ingest: new, then payment confirmed -> work_started; dedupe & no regression
  r = await anon.req('POST', '/api/ingest', { job_id: 'ALM-SMOKE-1', status: 'new', client: { name: 'Test Client', phone: '9999999999' }, plot: '5 cent', floors: 2, area_band: '1500-2000', payment: { amount: 5000, paid_at: '' } }, auth);
  assert.ok(r.body.created && r.body.stage === 'new'); ok('ingest creates job at stage new');
  r = await anon.req('POST', '/api/ingest', { job_id: 'ALM-SMOKE-1', status: 'work_started', client: { name: 'Test Client', phone: '9999999999' }, payment: { amount: 5000, paid_at: '2026-10-10T12:09:45Z' } }, auth);
  assert.ok(!r.body.created && r.body.stage === 'work_started'); ok('payment confirmed -> work_started (deduped by job_id)');
  r = await anon.req('POST', '/api/ingest', { job_id: 'ALM-SMOKE-1', status: 'new', client: { name: 'Test Client', phone: '9999999999' }, payment: { paid_at: '' } }, auth);
  assert.ok(!r.body.changed && r.body.stage === 'work_started'); ok('stale "new" re-send does not regress stage or change anything');

  // login
  r = await anon.req('GET', '/api/jobs'); assert.strictEqual(r.status, 401); ok('board requires login');
  const owner = new Client();
  r = await owner.req('POST', '/api/login', { staff_id: 'owner', pin: '0000' }); assert.strictEqual(r.status, 401); ok('wrong owner PIN rejected');
  await owner.login('owner', '9090'); ok('owner logs in with env PIN');

  // team
  r = await owner.req('GET', '/api/staff');
  const staff = r.body.staff;
  const sr = staff.find((s) => s.role === 'senior_architect'), dr = staff.find((s) => s.role === 'drafter'), sv = staff.find((s) => s.role === 'surveyor');
  assert.ok(sr && dr && sv); ok('seeded placeholder staff present');
  for (const [s, pin] of [[sr, '1111'], [dr, '2222'], [sv, '3333']]) {
    r = await owner.req('PATCH', '/api/staff/' + s.id, { pin, telegram_chat_id: String(2000000 + Math.floor(Math.random() * 1000)) });
    assert.strictEqual(r.status, 200);
  }
  r = await owner.req('POST', '/api/staff', { name: 'Drafter 2 (placeholder)', role: 'drafter', pin: '4444' }); assert.strictEqual(r.status, 200);
  const dr2 = r.body.staff; ok('owner sets PINs / chat ids and adds staff');
  r = await owner.req('GET', '/api/staff'); assert.ok(r.body.staff.every((s) => !('pin_hash' in s))); ok('API never exposes PIN hashes');

  const drafter = new Client(), senior = new Client(), surveyor = new Client(), drafter2 = new Client();
  await drafter.login(dr.id, '2222'); await senior.login(sr.id, '1111'); await surveyor.login(sv.id, '3333'); await drafter2.login(dr2.id, '4444');
  r = await drafter.req('GET', '/api/staff'); assert.ok(r.body.staff.length === 1 && !('telegram_chat_id' in r.body.staff[0])); ok('drafter sees only self in staff list');
  r = await drafter.req('GET', '/api/jobs/ALM-SMOKE-1'); assert.strictEqual(r.body.job.client_phone, ''); ok('client phone hidden from drafter');

  const J = '/api/jobs/ALM-SMOKE-1/actions';
  // permission / stage-order checks
  r = await drafter.req('POST', J, { action: 'assign_drafter', staff_id: dr.id }); assert.strictEqual(r.status, 403); ok('drafter cannot assign');
  r = await senior.req('POST', J, { action: 'assign_drafter', staff_id: dr.id }); assert.strictEqual(r.status, 403); ok('cannot assign drafter before survey verified (stage order)');

  // assign surveyor -> survey verified
  r = await senior.req('POST', J, { action: 'assign_surveyor', staff_id: sv.id }); assert.strictEqual(r.status, 200); ok('senior assigns surveyor');
  r = await surveyor.req('POST', J, { action: 'survey_verified' }); assert.strictEqual(r.body.job.stage, 'survey_verified'); ok('surveyor marks survey verified (own job)');

  // assign drafter
  r = await senior.req('POST', J, { action: 'assign_drafter', staff_id: dr.id, text: 'R0 plan please' });
  assert.strictEqual(r.body.job.stage, 'drafting'); assert.strictEqual(r.body.job.drafter.id, dr.id); ok('senior assigns drafter -> drafting');
  r = await owner.req('GET', '/api/debug/outbox');
  assert.ok(r.body.outbox.some((m) => m.tag === 'Drafter 1 (placeholder):assign_drafter' && /New drafting assignment/.test(m.text)), 'assignee msg');
  assert.ok(r.body.outbox.some((m) => m.tag.startsWith('owner:assign_drafter'))); ok('assignee + owner Telegram messages produced (dry-run)');

  // draft ready
  r = await drafter2.req('POST', J, { action: 'draft_ready', file_url: 'https://example.com/r0.pdf' }); assert.strictEqual(r.status, 403); ok('other drafter cannot mark draft ready (not own job)');
  r = await drafter.req('POST', J, { action: 'draft_ready', file_url: 'javascript:alert(1)' }); assert.strictEqual(r.status, 400); ok('non-http file link rejected');
  r = await drafter.req('POST', J, { action: 'draft_ready', file_url: 'https://example.com/r0.pdf', label: 'R0 PDF' }); assert.strictEqual(r.body.job.stage, 'draft_ready'); ok('drafter marks draft ready with file link');

  // senior verify path incl. request changes round-trip
  r = await drafter.req('POST', J, { action: 'senior_verify' }); assert.strictEqual(r.status, 403); ok('drafter cannot senior-verify');
  r = await senior.req('POST', J, { action: 'request_changes' }); assert.strictEqual(r.status, 400); ok('request changes needs a reason');
  r = await senior.req('POST', J, { action: 'request_changes', text: 'Stair width' }); assert.strictEqual(r.body.job.stage, 'drafting');
  r = await drafter.req('POST', J, { action: 'draft_ready', file_url: 'https://example.com/r1.pdf' }); assert.strictEqual(r.body.job.stage, 'draft_ready'); ok('changes requested -> redraft -> draft ready again');
  r = await senior.req('POST', J, { action: 'senior_verify', text: 'OK' }); assert.strictEqual(r.body.job.stage, 'senior_verified'); ok('senior architect verifies');

  // send / approve / note
  r = await senior.req('POST', J, { action: 'approve' }); assert.strictEqual(r.status, 403); ok('only owner can approve');
  r = await senior.req('POST', J, { action: 'send_to_client' }); assert.strictEqual(r.body.job.stage, 'sent_to_client');
  r = await owner.req('POST', J, { action: 'approve' }); assert.strictEqual(r.body.job.stage, 'approved'); ok('send to client -> owner approves');
  r = await surveyor.req('POST', J, { action: 'note', text: 'site photos uploaded' }); assert.strictEqual(r.status, 200); ok('assigned staff can add a note');
  r = await drafter2.req('POST', J, { action: 'note', text: 'hello' }); assert.strictEqual(r.status, 403); ok('unrelated drafter cannot add a note');

  // history
  r = await owner.req('GET', '/api/jobs/ALM-SMOKE-1');
  const acts = r.body.job.history.map((h) => h.action);
  for (const a of ['created', 'assign_surveyor', 'survey_verified', 'assign_drafter', 'draft_ready', 'senior_verify', 'send_to_client', 'approve', 'note']) assert.ok(acts.includes(a), 'history has ' + a);
  assert.ok(r.body.job.history.every((h) => h.at && h.by && h.by.name)); ok('every action logged with who/when');

  // my work + summary
  await owner.req('POST', '/api/ingest', { job_id: 'ALM-SMOKE-2', client: { name: 'B' }, payment: { paid_at: '2026-10-10T00:00:00Z' } }, auth);
  r = await senior.req('GET', '/api/my-work'); assert.ok(Array.isArray(r.body.pending)); ok('my-work page data');
  r = await anon.req('GET', '/api/summary'); assert.strictEqual(r.status, 401);
  r = await anon.req('GET', '/api/summary', null, auth); assert.ok(r.body.pending_count >= 1 && r.body.counts_by_stage.approved === 1); ok('summary endpoint (secret) returns pending items');
  r = await owner.req('POST', '/api/summary/send', {}); assert.ok(r.body.dryRun); ok('summary send is dry-run');

  // owner-only
  r = await senior.req('POST', '/api/staff', { name: 'x', role: 'drafter' }); assert.strictEqual(r.status, 403);
  r = await anon.req('GET', '/api/debug/outbox'); assert.strictEqual(r.status, 401); ok('team management + debug are owner-only');
  r = await owner.req('DELETE', '/api/staff/' + dr2.id); assert.strictEqual(r.status, 200); ok('owner removes staff');
  r = await anon.req('POST', '/api/login', { staff_id: dr2.id, pin: '4444' }); assert.strictEqual(r.status, 401); ok('removed staff cannot log in');

  // static UI served
  const page = await fetch(BASE + '/'); assert.ok((await page.text()).includes('Office Desk')); ok('UI served');

  console.log(`\nSMOKE PASSED (${n} checks)`);
})().catch((e) => { console.error('\nSMOKE FAILED:', e.stack || e); process.exit(1); });
