// Studio pipeline, status mapping, permissions and job actions. Pure logic (no HTTP, no I/O).
const STAGES = [
  { key: 'new', en: 'New / awaiting payment' },
  { key: 'work_started', en: 'Work started' },
  { key: 'survey_verified', en: 'Survey verified' },
  { key: 'drafting', en: 'Drafting assigned' },
  { key: 'draft_ready', en: 'Draft ready' },
  { key: 'senior_verified', en: 'Senior verified' },
  { key: 'sent_to_client', en: 'Sent to client' },
  { key: 'approved', en: 'Approved' },
];
const RANK = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));
const stageLabel = (k) => { const s = STAGES.find((x) => x.key === k); return s ? `${s.en}` : k; };

const ROLES = ['owner', 'senior_architect', 'drafter', 'surveyor'];
const ROLE_LABELS = {
  owner: { en: 'Owner' },
  senior_architect: { en: 'Senior Architect' },
  drafter: { en: 'Drafter' },
  surveyor: { en: 'Surveyor' },
};

// roles: who may do it. own: roles restricted to jobs assigned to them. stages: allowed current stages.
const ACTIONS = {
  assign_drafter: { en: 'Assign drafter', roles: ['owner', 'senior_architect'], stages: ['survey_verified', 'drafting'] },
  assign_surveyor: { en: 'Assign surveyor', roles: ['owner', 'senior_architect'], stages: ['new', 'work_started', 'survey_verified'] },
  survey_verified: { en: 'Mark survey verified', roles: ['owner', 'senior_architect', 'surveyor'], own: ['surveyor'], stages: ['work_started'] },
  draft_ready: { en: 'Mark draft ready', roles: ['owner', 'drafter'], own: ['drafter'], stages: ['drafting'] },
  senior_verify: { en: 'Senior architect verify', roles: ['owner', 'senior_architect'], stages: ['draft_ready'] },
  request_changes: { en: 'Request changes', roles: ['owner', 'senior_architect'], stages: ['draft_ready'] },
  send_to_client: { en: 'Mark sent to client', roles: ['owner', 'senior_architect'], stages: ['senior_verified'] },
  approve: { en: 'Approve', roles: ['owner'], stages: ['sent_to_client'] },
  note: { en: 'Add note', roles: ['owner', 'senior_architect', 'drafter', 'surveyor'], own: ['drafter', 'surveyor'], stages: null },
  set_stage: { en: 'Override stage (owner)', roles: ['owner'], stages: null },
};

function isOwnJob(actor, job) {
  return (actor.role === 'drafter' && job.drafter_id === actor.id) || (actor.role === 'surveyor' && job.surveyor_id === actor.id);
}

function can(actor, action, job) {
  const a = ACTIONS[action];
  if (!a) return { ok: false, reason: 'unknown action' };
  if (!a.roles.includes(actor.role)) return { ok: false, reason: 'not permitted for your role' };
  if (a.own && a.own.includes(actor.role) && !isOwnJob(actor, job)) return { ok: false, reason: 'only on jobs assigned to you' };
  if (a.stages && !a.stages.includes(job.stage)) return { ok: false, reason: `not allowed at stage "${job.stage}"` };
  return { ok: true };
}
const allowedActions = (actor, job) => Object.keys(ACTIONS).filter((k) => can(actor, k, job).ok);

// ---- status mapping (webhook payload -> stage) ----
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const STATUS_MAP = {
  new: 'new', submitted: 'new', received: 'new', created: 'new',
  workstarted: 'work_started', paymentconfirmed: 'work_started', paid: 'work_started',
  surveyverified: 'survey_verified',
  drafting: 'drafting', draftingassigned: 'drafting',
  draftready: 'draft_ready',
  seniorarchitectverified: 'senior_verified', seniorverified: 'senior_verified', architectverified: 'senior_verified',
  senttoclient: 'sent_to_client',
  approved: 'approved', clientapproved: 'approved',
};
const mapStatus = (s) => STATUS_MAP[norm(s)] || null;

const str = (v) => (v === undefined || v === null || typeof v === 'object' ? '' : String(v).trim());
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return undefined;
}
function describePlot(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'object') return String(v).trim().slice(0, 120);
  return Object.entries(v).filter(([, x]) => x !== null && typeof x !== 'object' && x !== '').map(([k, x]) => `${k}: ${x}`).join(', ').slice(0, 120);
}
function areaBand(p) {
  const raw = pick(p, ['area_band', 'areaBand', 'areaBandSqft', 'area_band_sqft', 'area', 'built_up_area', 'builtUpArea']);
  if (raw === undefined || typeof raw === 'object') return '';
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0 && String(raw).trim() !== '') { const lo = Math.floor(n / 500) * 500; return `${lo}-${lo + 500} sq.ft`; }
  return String(raw).trim().slice(0, 60);
}

// Extract a normalised job snapshot from the webhook JSON (tolerant: payloads vary).
function parseIngest(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const jobId = str(pick(p, ['job_id', 'jobId', 'briefId', 'brief_id', 'id']));
  if (!jobId) return null;
  const c = p.client && typeof p.client === 'object' ? p.client : {};
  const pay = p.payment && typeof p.payment === 'object' ? p.payment : {};
  const sv = p.survey_verification && typeof p.survey_verification === 'object' ? p.survey_verification : {};
  const fp = p.final_plan && typeof p.final_plan === 'object' ? p.final_plan : {};
  const files = Array.isArray(fp.files) ? fp.files.map((f) => (typeof f === 'string' ? f : str(pick(f, ['url', 'link', 'href', 'name'])))).filter(Boolean).slice(0, 20) : [];
  const amt = Number(pay.amount);
  return {
    job_id: jobId.slice(0, 80),
    client_name: str(pick(c, ['name']) || pick(p, ['client_name', 'clientName'])).slice(0, 120),
    client_phone: str(pick(c, ['phone', 'mobile']) || pick(p, ['phone', 'client_phone'])).slice(0, 30),
    plot: describePlot(p.plot),
    floors: str(pick(p, ['floors', 'floor_count'])).slice(0, 20),
    area_band: areaBand(p),
    payment_amount: Number.isFinite(amt) && pay.amount !== '' && pay.amount !== null ? amt : null,
    paid_at: str(pay.paid_at).slice(0, 40),
    status: str(p.status),
    survey_status: str(sv.status).toLowerCase(),
    plan_files: files,
    plan_approved: fp.approved === true || fp.approved === 'true',
  };
}

// Highest stage the payload justifies (ingest only moves jobs FORWARD: the platform re-sends old states).
function targetStage(snap) {
  let t = 'new';
  const bump = (k) => { if (k && RANK[k] > RANK[t]) t = k; };
  bump(mapStatus(snap.status));
  if (snap.paid_at) bump('work_started');
  if (/^(verified|approved|done|complete|completed)$/.test(snap.survey_status)) bump('survey_verified');
  if (snap.plan_approved) bump('approved');
  return t;
}

module.exports = { STAGES, RANK, stageLabel, ROLES, ROLE_LABELS, ACTIONS, can, allowedActions, isOwnJob, mapStatus, parseIngest, targetStage };
