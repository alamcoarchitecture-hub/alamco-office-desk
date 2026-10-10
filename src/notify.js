// Telegram notifications. DRY_RUN=1 (or missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) prints instead of sending.
// The bot token is never logged; error text is scrubbed of it.
const outbox = []; // dry-run record, readable by owner at /api/debug/outbox (dry-run only)

function isDryRun() {
  if (process.env.DRY_RUN === '1') return true;
  return !(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}
const scrub = (s) => { const t = process.env.TELEGRAM_BOT_TOKEN; return t ? String(s).split(t).join('[token]') : String(s); };

async function send(chatId, text, tag) {
  const body = String(text).slice(0, 3900);
  if (!chatId) return { skipped: 'no chat id' };
  if (isDryRun()) {
    outbox.push({ at: new Date().toISOString(), to: String(chatId), tag, text: body });
    if (outbox.length > 200) outbox.shift();
    console.log(`[notify:dry-run] ${tag || ''} -> chat ${chatId}\n${body.split('\n').map((l) => '    ' + l).join('\n')}`);
    return { dryRun: true };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(`Telegram HTTP ${res.status}: ${scrub(JSON.stringify(data)).slice(0, 160)}`);
    console.log(`[notify] sent ${tag || ''} -> chat ${chatId}`);
    return { ok: true };
  } catch (e) {
    console.error('[notify] failed:', scrub(e.message));
    return { error: true };
  }
}

const toOwner = (text, tag) => send(process.env.TELEGRAM_CHAT_ID, text, `owner:${tag || ''}`);
const toStaff = (staff, text, tag) => (staff && staff.telegram_chat_id ? send(staff.telegram_chat_id, text, `${staff.name}:${tag || ''}`) : Promise.resolve({ skipped: 'no telegram_chat_id' }));

module.exports = { isDryRun, toOwner, toStaff, outbox };
