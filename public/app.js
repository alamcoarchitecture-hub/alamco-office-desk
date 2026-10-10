'use strict';
const $ = (s) => document.querySelector(s);
const view = $('#view');
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
const stageName = (k) => { const s = meta.stages.find((x) => x.key === k); return s ? `${s.ml} / ${s.en}` : k; };
const roleName = (r) => { const l = meta.role_labels[r]; return l ? `${l.ml} / ${l.en}` : r; };
const actLabel = (k) => `${meta.actions[k].ml} / ${meta.actions[k].en}`;
const fmt = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

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
  view.replaceChildren(h('div', { class: 'login' },
    h('h1', {}, 'Alamco Studio Office Desk'),
    h('div', { class: 'hint' }, 'നിങ്ങളുടെ പേര് തിരഞ്ഞെടുത്ത് PIN നൽകുക / Choose your name and enter your PIN'),
    sel, pin, h('button', { class: 'btn', onclick: go }, 'ലോഗിൻ / Login')));
}

// ---------- board ----------
async function boardView() {
  const { jobs } = await api('/api/jobs');
  const cols = meta.stages.map((s) => {
    const list = jobs.filter((j) => j.stage === s.key);
    return h('section', { class: 'col' },
      h('h3', {}, h('span', {}, `${s.ml} / ${s.en}`), h('span', { class: 'n' }, list.length)),
      list.map((j) => h('a', { class: 'card', href: `#/job/${encodeURIComponent(j.job_id)}` },
        h('div', { class: 'id' }, j.job_id),
        h('div', {}, j.client_name || '—'),
        h('div', { class: 'meta' }, [j.plot && `Plot: ${j.plot}`, j.area_band && `Area: ${j.area_band}`, j.floors && `Floors: ${j.floors}`].filter(Boolean).join(' · ')),
        h('div', {}, h('span', { class: 'tag ' + (j.paid ? 'paid' : 'unpaid') }, j.paid ? 'പണം ലഭിച്ചു / Paid' : 'പണം ബാക്കി / Unpaid'),
          j.assignee && h('span', { class: 'tag' }, '👤 ' + j.assignee)))));
  });
  view.replaceChildren(h('h1', {}, 'ജോലി ബോർഡ് / Job board'), h('div', { class: 'hint' }, 'കാർഡ് തൊട്ടാൽ വിശദാംശങ്ങളും പ്രവർത്തനങ്ങളും കാണാം / Tap a card for details and actions'),
    jobs.length ? null : h('p', {}, 'ഇതുവരെ ജോലികളൊന്നും വന്നിട്ടില്ല / No jobs yet'), h('div', { class: 'board' }, cols));
}

// ---------- job detail ----------
const NEED = {
  assign_drafter: ['staff:drafter'], assign_surveyor: ['staff:surveyor'],
  draft_ready: ['file_url', 'label'], request_changes: ['text*'], note: ['text*'], set_stage: ['stage', 'text*'],
};
async function jobView(id) {
  const [{ job }, staffRes] = await Promise.all([api('/api/jobs/' + encodeURIComponent(id)), api('/api/staff')]);
  const staff = staffRes.staff;
  const kv = (k, v) => [h('div', {}, k), h('div', {}, v || '—')];
  const actionBoxes = job.allowed_actions.map((a) => {
    const inputs = {};
    const fields = (NEED[a] || []).concat(['assign_drafter', 'assign_surveyor', 'draft_ready', 'request_changes', 'note', 'set_stage'].includes(a) ? [] : ['text']);
    const els = fields.map((f) => {
      const [name, req] = [f.replace(/[*]|staff:.*/g, ''), f.endsWith('*')];
      let el;
      if (f.startsWith('staff:')) {
        const role = f.split(':')[1];
        el = h('select', {}, staff.filter((s) => s.role === role).map((s) => h('option', { value: s.id }, s.name)));
        inputs.staff_id = el;
      } else if (name === 'stage') {
        el = h('select', {}, meta.stages.map((s) => h('option', { value: s.key }, `${s.ml} / ${s.en}`)));
        inputs.stage = el;
      } else if (name === 'file_url') {
        el = h('input', { type: 'url', placeholder: 'ഫയൽ ലിങ്ക് / File link (https://…)' }); inputs.file_url = el;
      } else if (name === 'label') {
        el = h('input', { placeholder: 'ലേബൽ / Label (optional, e.g. R1 PDF)' }); inputs.label = el;
      } else {
        el = h('textarea', { placeholder: req ? 'എഴുതുക / Write here (required)' : 'കുറിപ്പ് / Note (optional)' }); inputs.text = el;
      }
      return el;
    });
    const btn = h('button', { class: 'btn' + (a === 'request_changes' ? ' sec' : '') }, actLabel(a));
    btn.addEventListener('click', async () => {
      const body = { action: a };
      for (const [k, el] of Object.entries(inputs)) body[k] = el.value;
      btn.disabled = true;
      try { await api(`/api/jobs/${encodeURIComponent(job.job_id)}/actions`, 'POST', body); toast('ശരി / Done'); await route(); } catch (e) { toast(e.message, true); btn.disabled = false; }
    });
    return h('div', { class: 'act' }, els, btn);
  });
  view.replaceChildren(
    h('p', {}, h('a', { href: '#/board' }, '← ബോർഡ് / Board')),
    h('h1', {}, `${job.job_id} — ${job.client_name || ''}`),
    h('div', { class: 'grid2' },
      h('div', { class: 'panel' }, h('h2', {}, 'വിശദാംശങ്ങൾ / Details'), h('div', { class: 'kv' },
        kv('Stage / ഘട്ടം', stageName(job.stage)), kv('Client / ക്ലയന്റ്', job.client_name), job.client_phone ? kv('Phone', job.client_phone) : [],
        kv('Plot', job.plot), kv('Floors', job.floors), kv('Area band', job.area_band),
        kv('Payment / പണം', job.paid ? `ലഭിച്ചു / Paid${job.payment_amount != null ? ' ₹' + job.payment_amount : ''} (${fmt(job.paid_at)})` : 'ബാക്കി / Not paid'),
        kv('Surveyor', job.surveyor && job.surveyor.name), kv('Drafter', job.drafter && job.drafter.name),
        kv('Drafts / ഡ്രാഫ്റ്റ്', job.draft_files.length ? job.draft_files.map((f) => h('div', {}, h('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer' }, f.label || f.url), ` (${f.by})`)) : ''))),
      h('div', { class: 'panel' }, h('h2', {}, 'പ്രവർത്തനങ്ങൾ / Actions'),
        actionBoxes.length ? h('div', { class: 'actions' }, actionBoxes) : h('p', { class: 'hint' }, 'ഈ സ്റ്റേജിൽ നിങ്ങൾക്ക് ചെയ്യാനൊന്നുമില്ല / Nothing for you to do at this stage'))),
    h('div', { class: 'panel' }, h('h2', {}, 'ചരിത്രം / History'),
      h('ul', { class: 'hist' }, job.history.slice().reverse().map((e) => h('li', {},
        h('div', { class: 't' }, `${fmt(e.at)} · ${e.by.name} (${e.by.role})`),
        h('div', {}, `${e.action}${e.from ? ` — ${e.from} → ${e.to}` : ''}${e.detail ? ': ' + e.detail : ''}`))))));
}

// ---------- my work ----------
async function myView() {
  const d = await api('/api/my-work');
  const pend = d.pending.length ? h('table', {}, d.pending.map((p) => h('tr', {}, h('td', {}, h('a', { href: `#/job/${encodeURIComponent(p.job_id)}` }, p.job_id)), h('td', {}, p.client), h('td', {}, p.what), h('td', {}, p.idle_days ? p.idle_days + 'd' : '')))) : h('p', { class: 'hint' }, 'ബാക്കിയൊന്നുമില്ല 🎉 / Nothing pending');
  view.replaceChildren(h('h1', {}, `എന്റെ ജോലി / My work — ${d.user.name}`), h('div', { class: 'panel' }, h('h2', {}, 'ബാക്കിയുള്ളവ / Pending'), pend),
    h('div', { class: 'panel' }, h('h2', {}, 'എന്നെ ഏൽപ്പിച്ചവ / Assigned to me'),
      d.jobs.length ? d.jobs.map((j) => h('a', { class: 'card', href: `#/job/${encodeURIComponent(j.job_id)}` }, h('div', { class: 'id' }, `${j.job_id} — ${j.client_name || ''}`), h('div', { class: 'meta' }, stageName(j.stage)))) : h('p', { class: 'hint' }, 'ഒന്നുമില്ല / None')));
}

// ---------- summary ----------
async function summaryView() {
  const s = await api('/api/summary');
  view.replaceChildren(h('h1', {}, 'ഇന്നത്തെ സംഗ്രഹം / Daily summary'), h('pre', { class: 'sum' }, s.text),
    me.role === 'owner' && h('button', { class: 'btn', onclick: async () => { try { const r = await api('/api/summary/send', 'POST', {}); toast(r.dryRun ? 'Dry-run: അയച്ചില്ല (ലോഗിൽ) / printed, not sent' : 'Telegram-ൽ അയച്ചു / Sent'); } catch (e) { toast(e.message, true); } } }, 'Telegram-ലേക്ക് അയക്കുക / Send to Telegram'));
}

// ---------- team (owner) ----------
async function teamView() {
  const { staff } = await api('/api/staff');
  const roles = meta.roles.filter((r) => r !== 'owner');
  const row = (s) => {
    const name = h('input', { value: s.name }), role = h('select', {}, roles.map((r) => h('option', { value: r, selected: r === s.role }, roleName(r)))),
      chat = h('input', { value: s.telegram_chat_id || '', placeholder: 'Telegram chat id', inputmode: 'numeric' }),
      pin = h('input', { type: 'password', placeholder: s.has_pin ? 'പുതിയ PIN (ഓപ്ഷണൽ) / new PIN' : 'PIN സജ്ജമാക്കുക / set PIN', inputmode: 'numeric', maxlength: '8', autocomplete: 'new-password' });
    const owner = s.id === 'owner';
    if (owner) { role.disabled = true; pin.disabled = true; pin.placeholder = 'DESK_OWNER_PIN (env)'; }
    const save = h('button', { class: 'btn', onclick: async () => { try { await api('/api/staff/' + s.id, 'PATCH', { name: name.value, role: owner ? undefined : role.value, telegram_chat_id: chat.value, pin: pin.value }); toast('സേവ് ചെയ്തു / Saved'); await teamView(); } catch (e) { toast(e.message, true); } } }, 'Save');
    const del = owner ? null : h('button', { class: 'btn danger', onclick: async () => { if (!confirm(`${s.name} നെ നീക്കം ചെയ്യണോ? / Remove?`)) return; try { await api('/api/staff/' + s.id, 'DELETE'); await teamView(); } catch (e) { toast(e.message, true); } } }, 'Remove');
    return h('div', { class: 'staffrow' }, h('div', {}, h('label', {}, 'Name'), name), h('div', {}, h('label', {}, 'Role'), role), h('div', {}, h('label', {}, 'Telegram chat id'), chat), h('div', {}, h('label', {}, s.has_pin ? 'PIN ✓' : 'PIN ✗'), pin), h('div', {}, save, ' ', del));
  };
  const n = h('input', { placeholder: 'പേര് / Name' }), r = h('select', {}, roles.map((x) => h('option', { value: x }, roleName(x)))), c = h('input', { placeholder: 'Telegram chat id (optional)', inputmode: 'numeric' }), p = h('input', { type: 'password', placeholder: 'PIN (4-8 digits)', inputmode: 'numeric', maxlength: '8', autocomplete: 'new-password' });
  view.replaceChildren(h('h1', {}, 'ടീം / Team'),
    h('div', { class: 'hint' }, 'ഓരോരുത്തർക്കും PIN സജ്ജമാക്കിയാലേ ലോഗിൻ ചെയ്യാൻ കഴിയൂ. Telegram chat id അറിയാൻ അവർ ബോട്ടിന് "Hi" അയക്കണം. / Staff can log in only after you set a PIN. Chat id is optional (needed for Telegram alerts).'),
    h('div', { class: 'panel' }, staff.map(row)),
    h('div', { class: 'panel' }, h('h2', {}, 'പുതിയ അംഗം / Add staff'), h('div', { class: 'staffrow' }, h('div', {}, n), h('div', {}, r), h('div', {}, c), h('div', {}, p),
      h('div', {}, h('button', { class: 'btn', onclick: async () => { try { await api('/api/staff', 'POST', { name: n.value, role: r.value, telegram_chat_id: c.value, pin: p.value }); toast('ചേർത്തു / Added'); await teamView(); } catch (e) { toast(e.message, true); } } }, 'Add')))));
}

// ---------- routing ----------
function nav() {
  const links = [['#/board', 'ബോർഡ് / Board'], ['#/my', 'എന്റെ ജോലി / My work'], ['#/summary', 'സംഗ്രഹം / Summary']];
  if (me.role === 'owner') links.push(['#/team', 'ടീം / Team']);
  const cur = location.hash || '#/board';
  $('#nav').replaceChildren(...links.map(([href, t]) => h('a', { href, class: cur.startsWith(href) ? 'on' : '' }, t)));
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
