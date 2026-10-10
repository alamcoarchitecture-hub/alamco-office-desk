// Job operations: ingest, actions, views, summary. Mutations return { job, messages } and the caller persists + notifies.
const P = require('./pipeline');

const now = () => new Date().toISOString();
const who = (a) => (a ? { id: a.id, name: a.name, role: a.role } : { id: 'system', name: 'System', role: 'system' });
const baseUrl = () => (process.env.DESK_BASE_URL || '').replace(/\/$/, '');
const link = (job) => (baseUrl() ? `\n${baseUrl()}/#/job/${encodeURIComponent(job.job_id)}` : '');
const title = (job) => `${job.job_id}${job.client_name ? ' — ' + job.client_name : ''}`;

function log(job, by, action, detail, from, to) {
  job.history.push({ at: now(), by: who(by), action, detail: detail || '', ...(from ? { from } : {}), ...(to ? { to } : {}) });
  job.updated_at = now();
}

function ingest(store, payload) {
  const snap = P.parseIngest(payload);
  if (!snap) return { error: 'job_id missing' };
  let job = store.jobs.get(snap.job_id);
  const created = !job;
  let changed = created;
  if (created) {
    job = {
      job_id: snap.job_id, client_name: '', client_phone: '', plot: '', floors: '', area_band: '',
      payment_amount: null, paid_at: '', stage: 'new', drafter_id: '', surveyor_id: '',
      draft_files: [], plan_files: [], created_at: now(), updated_at: now(), history: [],
    };
    store.jobs.set(job.job_id, job);
    log(job, null, 'created', 'Job received from website webhook');
  }
  // Merge non-empty fields only (the platform sometimes sends partial payloads).
  const changes = [];
  for (const k of ['client_name', 'client_phone', 'plot', 'floors', 'area_band', 'paid_at']) {
    if (snap[k] && snap[k] !== job[k]) { job[k] = snap[k]; changes.push(k); }
  }
  if (snap.payment_amount !== null && snap.payment_amount !== job.payment_amount) { job.payment_amount = snap.payment_amount; changes.push('payment_amount'); }
  if (snap.plan_files.length && JSON.stringify(snap.plan_files) !== JSON.stringify(job.plan_files)) { job.plan_files = snap.plan_files; changes.push('plan_files'); }
  if (changes.length && !created) log(job, null, 'ingest_update', `Updated: ${changes.join(', ')}`);
  const target = P.targetStage(snap);
  if (P.RANK[target] > P.RANK[job.stage]) {
    const from = job.stage;
    job.stage = target;
    log(job, null, 'stage_from_website', `Website status "${snap.status || (snap.paid_at ? 'payment confirmed' : '')}"`, from, target);
    changed = true;
  }
  if (changes.length) changed = true;
  if (changed) job.updated_at = now();
  return { job, created, changed };
}

function setStage(job, actor, to, action, detail) {
  const from = job.stage;
  job.stage = to;
  log(job, actor, action, detail, from, to);
}

function validUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:'; } catch (_) { return false; }
}

// Returns { error, status } or { job, messages: [{to:'owner'|staffObj, text, tag}] }
function act(store, actor, job, body) {
  const action = String(body.action || '');
  const chk = P.can(actor, action, job);
  if (!chk.ok) return { error: chk.reason, status: P.ACTIONS[action] ? 403 : 400 };
  const text = String(body.text || body.note || '').trim().slice(0, 1000);
  const msgs = [];
  const A = P.ACTIONS[action];
  const ownerMsg = (extra) => msgs.push({ to: 'owner', tag: action, text: `🗂 Office Desk — ${A.ml} / ${A.en}\n${title(job)}\nBy: ${actor.name}${extra ? '\n' + extra : ''}\nStage: ${P.stageLabel(job.stage)}${link(job)}` });

  switch (action) {
    case 'assign_drafter':
    case 'assign_surveyor': {
      const isD = action === 'assign_drafter';
      const s = store.staffById(String(body.staff_id || ''));
      if (!s || s.role !== (isD ? 'drafter' : 'surveyor')) return { error: `staff must have role ${isD ? 'drafter' : 'surveyor'}`, status: 400 };
      const key = isD ? 'drafter_id' : 'surveyor_id';
      const prev = store.staffById(job[key]);
      job[key] = s.id;
      if (isD && job.stage === 'survey_verified') setStage(job, actor, 'drafting', action, `Assigned to ${s.name}`);
      else log(job, actor, action, `Assigned to ${s.name}${prev && prev.id !== s.id ? ` (was ${prev.name})` : ''}`);
      if (text) log(job, actor, 'note', text);
      msgs.push({ to: s, tag: action, text: `🎯 പുതിയ ജോലി / New ${isD ? 'drafting' : 'survey'} assignment\n${title(job)}${job.plot ? '\nPlot: ' + job.plot : ''}${job.area_band ? '\nArea: ' + job.area_band : ''}\nAssigned by: ${actor.name}${text ? '\nNote: ' + text : ''}${link(job)}` });
      ownerMsg(`Assignee: ${s.name}`);
      break;
    }
    case 'survey_verified':
      setStage(job, actor, 'survey_verified', action, text);
      ownerMsg();
      break;
    case 'draft_ready': {
      const url = String(body.file_url || '').trim();
      if (!validUrl(url)) return { error: 'ഫയൽ ലിങ്ക് (http/https) വേണം / a valid file link (http/https) is required', status: 400 };
      job.draft_files.push({ url: url.slice(0, 500), label: String(body.label || '').trim().slice(0, 80), by: who(actor).name, at: now() });
      setStage(job, actor, 'draft_ready', action, `Draft: ${url.slice(0, 200)}${text ? ' | ' + text : ''}`);
      ownerMsg(`File: ${url.slice(0, 200)}`);
      store.staff.filter((s) => s.role === 'senior_architect').forEach((s) => msgs.push({ to: s, tag: action, text: `📐 ഡ്രാഫ്റ്റ് പരിശോധനയ്ക്ക് / Draft ready for your verification\n${title(job)}\nDrafter: ${actor.name}\nFile: ${url.slice(0, 200)}${link(job)}` }));
      break;
    }
    case 'senior_verify':
      setStage(job, actor, 'senior_verified', action, text);
      ownerMsg();
      break;
    case 'request_changes': {
      if (!text) return { error: 'മാറ്റങ്ങൾ എഴുതുക / describe the changes needed', status: 400 };
      setStage(job, actor, 'drafting', action, text);
      ownerMsg(`Changes: ${text}`);
      const d = store.staffById(job.drafter_id);
      if (d) msgs.push({ to: d, tag: action, text: `✏️ മാറ്റങ്ങൾ വേണം / Changes requested\n${title(job)}\nBy: ${actor.name}\n${text}${link(job)}` });
      break;
    }
    case 'send_to_client':
      setStage(job, actor, 'sent_to_client', action, text);
      ownerMsg();
      break;
    case 'approve':
      setStage(job, actor, 'approved', action, text);
      ownerMsg();
      break;
    case 'note':
      if (!text) return { error: 'കുറിപ്പ് ശൂന്യമാണ് / note is empty', status: 400 };
      log(job, actor, 'note', text);
      if (actor.role !== 'owner') ownerMsg(`Note: ${text}`);
      break;
    case 'set_stage': {
      const to = String(body.stage || '');
      if (!(to in P.RANK)) return { error: 'unknown stage', status: 400 };
      if (!text) return { error: 'കാരണം എഴുതുക / reason required', status: 400 };
      setStage(job, actor, to, action, text);
      ownerMsg(`Reason: ${text}`);
      break;
    }
    default:
      return { error: 'unknown action', status: 400 };
  }
  return { job, messages: msgs };
}

function view(store, job, actor) {
  const canSeePhone = actor.role === 'owner' || actor.role === 'senior_architect';
  const d = store.staffById(job.drafter_id), sv = store.staffById(job.surveyor_id);
  const { drafter_id, surveyor_id, client_phone, ...rest } = job;
  return {
    ...rest,
    client_phone: canSeePhone ? client_phone : '',
    paid: !!job.paid_at,
    drafter: d ? { id: d.id, name: d.name } : null,
    surveyor: sv ? { id: sv.id, name: sv.name } : null,
    assignee: (d || sv) ? (d || sv).name : '',
    allowed_actions: P.allowedActions(actor, job),
  };
}

const ageDays = (job) => Math.floor((Date.now() - new Date(job.updated_at).getTime()) / 86400000);
function pendingFor(store, actor) {
  // Items waiting on `actor` (or on everyone when actor is owner).
  const out = [];
  const add = (job, what) => out.push({ job_id: job.job_id, client: job.client_name, stage: job.stage, what, idle_days: ageDays(job) });
  for (const job of store.jobs.values()) {
    if (job.stage === 'approved') continue;
    const mine = (r) => actor.role === 'owner' || actor.role === r;
    if (job.stage === 'new' && mine('owner')) add(job, 'Awaiting payment confirmation / പണം കാത്തിരിക്കുന്നു');
    if (job.stage === 'work_started') {
      if (!job.surveyor_id && (actor.role === 'owner' || actor.role === 'senior_architect')) add(job, 'Assign surveyor / സർവേയറെ ഏൽപ്പിക്കുക');
      if (job.surveyor_id && (actor.role === 'owner' || (actor.role === 'surveyor' && job.surveyor_id === actor.id))) add(job, 'Survey to be verified / സർവേ പരിശോധിക്കണം');
    }
    if (job.stage === 'survey_verified' && (actor.role === 'owner' || actor.role === 'senior_architect')) add(job, 'Assign drafter / ഡ്രാഫ്റ്റർക്ക് ഏൽപ്പിക്കുക');
    if (job.stage === 'drafting' && (actor.role === 'owner' || (actor.role === 'drafter' && job.drafter_id === actor.id))) add(job, 'Drafting in progress / ഡ്രാഫ്റ്റിംഗ് നടക്കുന്നു');
    if (job.stage === 'draft_ready' && (actor.role === 'owner' || actor.role === 'senior_architect')) add(job, 'Senior verification pending / സീനിയർ പരിശോധന');
    if (job.stage === 'senior_verified' && (actor.role === 'owner' || actor.role === 'senior_architect')) add(job, 'Send to client / ക്ലയന്റിന് അയക്കുക');
    if (job.stage === 'sent_to_client' && actor.role === 'owner') add(job, 'Awaiting client approval / ക്ലയന്റ് അംഗീകാരം കാത്തിരിക്കുന്നു');
  }
  return out.sort((a, b) => b.idle_days - a.idle_days);
}

function summary(store, actor) {
  const byStage = Object.fromEntries(P.STAGES.map((s) => [s.key, 0]));
  for (const j of store.jobs.values()) byStage[j.stage]++;
  const pending = pendingFor(store, actor);
  const lines = [`📋 Alamco Studio Office Desk — ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}`];
  lines.push(`${pending.length} pending / ബാക്കിയുള്ളവ`);
  pending.slice(0, 25).forEach((p) => lines.push(`• ${p.job_id}${p.client ? ' (' + p.client + ')' : ''}: ${p.what}${p.idle_days ? ` [${p.idle_days}d]` : ''}`));
  if (pending.length > 25) lines.push(`… +${pending.length - 25} more`);
  return { date: now(), counts_by_stage: byStage, pending_count: pending.length, pending, text: lines.join('\n') };
}

module.exports = { ingest, act, view, summary, pendingFor };
