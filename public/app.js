'use strict';
const $ = (s) => document.querySelector(s);
const view = $('#view');
// Replace the page content; children rise in with a small stagger (CSSOM only, CSP-safe).
function render(...kids) {
  const list = kids.flat().filter((k) => k !== null && k !== undefined && k !== false);
  list.forEach((k, i) => { k.classList.add('rise'); k.style.setProperty('animation-delay', (i * 60) + 'ms'); });
  view.replaceChildren(...list);
  window.scrollTo(0, 0);
}
let me = null, meta = null;

// Safe DOM builder: text is always set via textContent (no HTML injection from job data).
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 3500);
}
async function api(path, method, body) {
  const r = await fetch(path, { method: method || 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { me = null; route(); }
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
const stageName = (k) => { const s = meta.stages.find((x) => x.key === k); return s ? s.en : k; };
const roleName = (r) => { const l = meta.role_labels[r]; return l ? l.en : r; };
const actLabel = (k) => meta.actions[k].en;
const fmt = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
// Stages that are waiting on someone in the studio (gold accent).
const AWAITING = new Set(['new', 'draft_ready', 'senior_verified', 'sent_to_client']);
const stagePill = (k) => h('span', { class: 'pill' + (k === 'approved' ? ' approved' : AWAITING.has(k) ? ' await' : '') }, stageName(k));
const pageHead = (kicker, title, hint) => h('div', { class: 'page-head' }, h('span', { class: 'kicker' }, kicker), h('h1', {}, title), h('hr', { class: 'rule' }), hint ? h('p', { class: 'hint' }, hint) : null);
const field = (label, el) => h('div', { class: 'field' }, h('label', { class: 'kicker' }, label), el);

// ---------- login ----------
async function loginView() {
  $('#top').classList.add('hidden');
  const { staff } = await api('/api/login-options');
  const sel = h('select', { id: 'who' }, staff.map((s) => h('option', { value: s.id }, `${s.name} — ${roleName(s.role)}`)));
  const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'current-password', placeholder: 'PIN', maxlength: '12' });
  const go = async () => {
    try { await api('/api/login', 'POST', { staff_id: sel.value, pin: pin.value }); await boot(); } catch (e) { toast(e.message, true); }
  };
  pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  render(h('div', { class: 'login' },
    h('div', { class: 'brand' },
      h('span', { class: 'wm-name' }, 'ALAMCO'), h('span', { class: 'wm-sub' }, 'Architecture')),
    h('span', { class: 'kicker' }, 'Office Desk'),
    h('h1', {}, 'Welcome back to the ', h('em', {}, 'studio desk.')),
    h('hr', { class: 'rule' }),
    h('p', { class: 'hint' }, 'Choose your name and enter your PIN.'),
    field('Name', sel), field('PIN', pin),
    h('button', { class: 'btn block', onclick: go }, 'Log in')));
}

// ---------- board ----------
async function boardView() {
  const { jobs } = await api('/api/jobs');
  const cols = meta.stages.map((s) => {
    const list = jobs.filter((j) => j.stage === s.key);
    return h('section', { class: 'col' + (AWAITING.has(s.key) ? ' await' : '') },
      h('div', { class: 'col-head' }, h('h3', {}, s.en), h('span', { class: 'n' }, list.length)),
      list.length ? list.map((j) => h('a', { class: 'card', href: `#/job/${encodeURIComponent(j.job_id)}` },
        h('div', { class: 'id' }, j.job_id),
        h('div', { class: 'client' }, j.client_name || '—'),
        h('div', { class: 'meta' }, [j.plot && `Plot: ${j.plot}`, j.area_band && `Area: ${j.area_band}`, j.floors && `Floors: ${j.floors}`].filter(Boolean).join(' · ')),
        h('div', { class: 'row' }, h('span', { class: 'pill ' + (j.paid ? 'paid' : 'unpaid') }, j.paid ? 'Paid' : 'Unpaid'),
          j.assignee && h('span', { class: 'pill' }, j.assignee)))) : h('p', { class: 'empty' }, 'Nothing here'));
  });
  render(pageHead('Studio', 'Job board', 'Tap a card for details and actions.'),
    jobs.length ? null : h('p', { class: 'hint' }, 'No jobs yet.'), h('div', { class: 'board' }, cols));
}

// ---------- job detail ----------
const NEED = {
  assign_drafter: ['staff:drafter'], assign_surveyor: ['staff:surveyor'],
  draft_ready: ['file_url', 'label'], request_changes: ['text*'], note: ['text*'], set_stage: ['stage', 'text*'],
};
async function jobView(id) {
  const [{ job }, staffRes] = await Promise.all([api('/api/jobs/' + encodeURIComponent(id)), api('/api/staff')]);
  const staff = staffRes.staff;
  const kv = (k, v) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v || '—')];
  const actionBoxes = job.allowed_actions.map((a) => {
    const inputs = {};
    const fields = (NEED[a] || []).concat(['assign_drafter', 'assign_surveyor', 'draft_ready', 'request_changes', 'note', 'set_stage'].includes(a) ? [] : ['text']);
    const els = fields.map((f) => {
      const [name, req] = [f.replace(/[*]|staff:.*/g, ''), f.endsWith('*')];
      let el, lab;
      if (f.startsWith('staff:')) {
        const role = f.split(':')[1];
        el = h('select', {}, staff.filter((s) => s.role === role).map((s) => h('option', { value: s.id }, s.name)));
        inputs.staff_id = el; lab = role === 'drafter' ? 'Drafter' : 'Surveyor';
      } else if (name === 'stage') {
        el = h('select', {}, meta.stages.map((s) => h('option', { value: s.key }, s.en)));
        inputs.stage = el; lab = 'Stage';
      } else if (name === 'file_url') {
        el = h('input', { type: 'url', placeholder: 'File link (https://…)' }); inputs.file_url = el; lab = 'File link';
      } else if (name === 'label') {
        el = h('input', { placeholder: 'Label (optional, e.g. R1 PDF)' }); inputs.label = el; lab = 'Label';
      } else {
        el = h('textarea', { placeholder: req ? 'Write here (required)' : 'Note (optional)' }); inputs.text = el; lab = req ? 'Note (required)' : 'Note';
      }
      return field(lab, el);
    });
    const btn = h('button', { class: 'btn' + (a === 'request_changes' ? ' sec' : '') }, actLabel(a));
    btn.addEventListener('click', async () => {
      const body = { action: a };
      for (const [k, el] of Object.entries(inputs)) body[k] = el.value;
      btn.disabled = true;
      try { await api(`/api/jobs/${encodeURIComponent(job.job_id)}/actions`, 'POST', body); toast('Done'); await route(); } catch (e) { toast(e.message, true); btn.disabled = false; }
    });
    return h('div', { class: 'act' }, els, btn);
  });
  const cur = meta.stages.findIndex((s) => s.key === job.stage);
  const progress = h('ol', { class: 'tl' }, meta.stages.map((s, i) => h('li', { class: i < cur || job.stage === 'approved' ? 'done' : i === cur ? 'now' : 'todo' },
    h('span', { class: 'dot' }), h('div', { class: 'stage-name' }, s.en))));
  const hist = job.history.slice().reverse();
  const timeline = h('ol', { class: 'tl' }, hist.map((e, i) => h('li', { class: i === 0 ? 'now' : 'done' },
    h('span', { class: 'dot' }),
    h('div', { class: 't' }, `${fmt(e.at)} · ${e.by.name} (${e.by.role})`),
    h('div', { class: 'what' }, `${e.action}${e.from ? ` — ${e.from} → ${e.to}` : ''}${e.detail ? ': ' + e.detail : ''}`))));
  render(
    h('a', { class: 'back', href: '#/board' }, '← Board'),
    h('div', { class: 'job-head' }, h('span', { class: 'kicker' }, 'Job'), h('h1', {}, job.job_id), h('div', { class: 'client' }, job.client_name || ''),
      h('div', { class: 'row' }, stagePill(job.stage), h('span', { class: 'pill ' + (job.paid ? 'paid' : 'unpaid') }, job.paid ? 'Paid' : 'Unpaid')), h('hr', { class: 'rule' })),
    h('div', { class: 'job-grid' },
      h('div', { class: 'panel' }, h('h2', {}, 'Details'), h('div', { class: 'kv' },
        kv('Stage', stageName(job.stage)), kv('Client', job.client_name), job.client_phone ? kv('Phone', job.client_phone) : [],
        kv('Plot', job.plot), kv('Floors', job.floors), kv('Area band', job.area_band),
        kv('Payment', job.paid ? `Paid${job.payment_amount != null ? ' ₹' + job.payment_amount : ''} (${fmt(job.paid_at)})` : 'Not paid'),
        kv('Surveyor', job.surveyor && job.surveyor.name), kv('Drafter', job.drafter && job.drafter.name),
        kv('Drafts', job.draft_files.length ? job.draft_files.map((f) => h('div', {}, h('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer' }, f.label || f.url), ` (${f.by})`)) : ''))),
      h('div', { class: 'panel' }, h('h2', {}, 'Actions'),
        actionBoxes.length ? h('div', { class: 'actions' }, actionBoxes) : h('p', { class: 'hint' }, 'Nothing for you to do at this stage.'))),
    h('div', { class: 'panel' }, h('h2', {}, 'Progress'), progress),
    h('div', { class: 'panel' }, h('h2', {}, 'History'), timeline));
}

// ---------- my work ----------
async function myView() {
  const d = await api('/api/my-work');
  const pend = d.pending.length ? h('div', { class: 'todo-list' }, d.pending.map((p) => h('a', { class: 'todo-item', href: `#/job/${encodeURIComponent(p.job_id)}` },
    h('div', { class: 'card id' }, p.job_id), h('div', {}, p.client || '—'), h('div', { class: 'what' }, p.what), p.idle_days ? h('div', { class: 'idle' }, `Idle ${p.idle_days}d`) : null))) : h('p', { class: 'hint' }, 'Nothing pending. All clear.');
  render(pageHead('Today', 'My work', d.user.name), h('div', { class: 'panel' }, h('h2', {}, 'Pending'), pend),
    h('div', { class: 'panel' }, h('h2', {}, 'Assigned to me'),
      d.jobs.length ? d.jobs.map((j) => h('a', { class: 'card', href: `#/job/${encodeURIComponent(j.job_id)}` }, h('div', { class: 'id' }, `${j.job_id} — ${j.client_name || ''}`), h('div', { class: 'row' }, stagePill(j.stage)))) : h('p', { class: 'hint' }, 'None.')));
}

// ---------- summary ----------
async function summaryView() {
  const s = await api('/api/summary');
  render(pageHead('Overview', 'Daily summary'), h('pre', { class: 'sum' }, s.text),
    me.role === 'owner' && h('button', { class: 'btn', onclick: async () => { try { const r = await api('/api/summary/send', 'POST', {}); toast(r.dryRun ? 'Dry-run: printed to the log, not sent' : 'Sent to Telegram'); } catch (e) { toast(e.message, true); } } }, 'Send to Telegram'));
}

// ---------- team (owner) ----------
async function teamView() {
  const { staff } = await api('/api/staff');
  const roles = meta.roles.filter((r) => r !== 'owner');
  const row = (s) => {
    const name = h('input', { value: s.name }), role = h('select', {}, roles.map((r) => h('option', { value: r, selected: r === s.role }, roleName(r)))),
      chat = h('input', { value: s.telegram_chat_id || '', placeholder: 'Telegram chat id', inputmode: 'numeric' }),
      pin = h('input', { type: 'password', placeholder: s.has_pin ? 'New PIN (optional)' : 'Set PIN', inputmode: 'numeric', maxlength: '8', autocomplete: 'new-password' });
    const owner = s.id === 'owner';
    if (owner) { role.disabled = true; pin.disabled = true; pin.placeholder = 'DESK_OWNER_PIN (env)'; }
    const save = h('button', { class: 'btn sm', onclick: async () => { try { await api('/api/staff/' + s.id, 'PATCH', { name: name.value, role: owner ? undefined : role.value, telegram_chat_id: chat.value, pin: pin.value }); toast('Saved'); await teamView(); } catch (e) { toast(e.message, true); } } }, 'Save');
    const del = owner ? null : h('button', { class: 'btn sm danger', onclick: async () => { if (!confirm(`Remove ${s.name}?`)) return; try { await api('/api/staff/' + s.id, 'DELETE'); await teamView(); } catch (e) { toast(e.message, true); } } }, 'Remove');
    return h('div', { class: 'staffrow' }, field('Name', name), field('Role', role), field('Telegram chat id', chat), field(s.has_pin ? 'PIN set' : 'PIN not set', pin), h('div', { class: 'btns' }, save, del));
  };
  const n = h('input', { placeholder: 'Name' }), r = h('select', {}, roles.map((x) => h('option', { value: x }, roleName(x)))), c = h('input', { placeholder: 'Telegram chat id (optional)', inputmode: 'numeric' }), p = h('input', { type: 'password', placeholder: 'PIN (4-8 digits)', inputmode: 'numeric', maxlength: '8', autocomplete: 'new-password' });
  render(pageHead('Studio', 'Team', 'Staff can log in only after you set a PIN. The Telegram chat id is optional (needed for Telegram alerts); staff get it by sending "Hi" to the bot.'),
    h('div', { class: 'panel' }, staff.map(row)),
    h('div', { class: 'panel' }, h('h2', {}, 'Add staff'), h('div', { class: 'staffrow' }, field('Name', n), field('Role', r), field('Telegram chat id', c), field('PIN', p),
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: async () => { try { await api('/api/staff', 'POST', { name: n.value, role: r.value, telegram_chat_id: c.value, pin: p.value }); toast('Added'); await teamView(); } catch (e) { toast(e.message, true); } } }, 'Add')))));
}

// ---------- routing ----------
function nav() {
  const links = [['#/board', 'Board'], ['#/my', 'My work'], ['#/summary', 'Summary']];
  if (me.role === 'owner') links.push(['#/team', 'Team']);
  const cur = location.hash || '#/board';
  $('#nav').replaceChildren(...links.map(([href, t]) => h('a', { href, class: cur.startsWith(href) || (href === '#/board' && cur.startsWith('#/job/')) ? 'on' : '' }, t)));
  $('#whoami').textContent = `${me.name} · ${roleName(me.role)}`;
  $('#top').classList.remove('hidden');
}
async function route() {
  try {
    if (!me) return await loginView();
    nav();
    const hash = location.hash || '#/board';
    if (hash.startsWith('#/job/')) await jobView(decodeURIComponent(hash.slice(6)));
    else if (hash === '#/my') await myView();
    else if (hash === '#/summary') await summaryView();
    else if (hash === '#/team' && me.role === 'owner') await teamView();
    else await boardView();
  } catch (e) { if (me) toast(e.message, true); }
}
async function boot() {
  meta = meta || await (await fetch('/api/meta')).json();
  try { me = (await api('/api/me')).user; } catch (_) { me = null; }
  await route();
}
$('#logout').addEventListener('click', async () => { await api('/api/logout', 'POST', {}); me = null; route(); });
window.addEventListener('hashchange', route);
boot();
