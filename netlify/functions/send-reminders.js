// ============================================================
// POST /api/send-reminders
//
// Cron-triggered (via GitHub Actions on a schedule — see
// .github/workflows/send-reminders.yml). Finds confirmed/new
// express_bookings whose service start is approximately 24
// hours away and that haven't received their reminder yet,
// then sends a WhatsApp reminder via respond.io.
//
// Authentication: requires header `x-cron-secret: <CRON_SECRET>`
// matching the CRON_SECRET env var. Without this anyone who
// guessed the URL could trigger blast messages.
//
// Required env vars:
//   CRON_SECRET             shared with the GitHub Actions job
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   RESPONDIO_API_TOKEN     respond.io API JWT
//   RESPONDIO_CHANNEL_ID    the numeric channel ID for the WA channel
//   SITE_URL                base URL for reschedule links (default: book.domoyourhome.com)
//
// Window: bookings whose start time falls in [now+23h, now+25h]
// (a 2h sweep gives slack for cron drift / retries).
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { mintBookingToken } = require('./_booking-token');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const PR_OFFSET_HOURS = -4;
const SITE_URL = process.env.SITE_URL || 'https://book.domoyourhome.com';

function slotStartUtcMs(iso, slot) {
  if (!iso || !slot) return 0;
  const [time, period] = slot.split(' ');
  let [h, m] = time.split(':').map(Number);
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  const [Y, M, D] = iso.split('-').map(Number);
  return Date.UTC(Y, M - 1, D, h - PR_OFFSET_HOURS, m || 0);
}

// Normalize a phone string to E.164 (+1XXXXXXXXXX assumed for PR / US).
// We don't claim to handle every international format — PR numbers are
// the realistic input.
function toE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length >= 11) return '+' + digits;
  return null;
}

async function sendRespondMessage(phoneE164, body) {
  const url = `https://api.respond.io/v2/contact/phone:${encodeURIComponent(phoneE164)}/message`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESPONDIO_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channelId: Number(process.env.RESPONDIO_CHANNEL_ID),
      message: { type: 'text', text: body },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`respond.io ${res.status}: ${text}`);
  }
  return res.json().catch(() => ({}));
}

function buildReminder(b) {
  const reschedToken = mintBookingToken(b.booking_id);
  const reschedUrl   = `${SITE_URL}/reschedule.html?token=${encodeURIComponent(reschedToken)}`;
  const tasks = [b.task_1, b.task_2].filter(Boolean).join(' y ');
  const first = (b.customer_name || '').split(' ')[0];
  return (
    `Hola ${first}, te recordamos tu Domo Express mañana ${b.booking_date} a las ${b.booking_time}.\n\n` +
    `Tareas: ${tasks}\n` +
    `Dirección: ${b.address}\n\n` +
    `Si necesitas reprogramar o cancelar dejanos saber o haz click aqui: ${reschedUrl}\n\n` +
    `— Domo`
  );
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const provided = (event.headers || {})['x-cron-secret'] || (event.headers || {})['X-Cron-Secret'];
  if (!process.env.CRON_SECRET || provided !== process.env.CRON_SECRET) {
    return { statusCode: 401, body: 'unauthorized' };
  }
  if (!process.env.RESPONDIO_API_TOKEN || !process.env.RESPONDIO_CHANNEL_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: 'respondio_not_configured' }) };
  }

  const nowMs = Date.now();
  const minMs = nowMs + 23 * 3600 * 1000;
  const maxMs = nowMs + 25 * 3600 * 1000;

  // Date range covering bookings 23-25h from now. We over-fetch by
  // date and filter precisely by slot time in JS — booking_date_iso
  // is just a date, so we can't easily express the 2h window in SQL.
  const minDate = new Date(minMs).toISOString().slice(0, 10);
  const maxDate = new Date(maxMs + 24 * 3600 * 1000).toISOString().slice(0, 10);

  const { data: candidates, error: fetchErr } = await supabase
    .from('express_bookings')
    .select('booking_id, customer_name, customer_phone, address, task_1, task_2, booking_date, booking_date_iso, booking_time, status')
    .gte('booking_date_iso', minDate)
    .lte('booking_date_iso', maxDate)
    .is('reminder_sent_at', null)
    .neq('status', 'cancelled');

  if (fetchErr) {
    console.error('send-reminders: supabase fetch error', fetchErr);
    return { statusCode: 500, body: JSON.stringify({ error: 'db_error', detail: fetchErr.message }) };
  }

  const due = (candidates || []).filter(b => {
    const startMs = slotStartUtcMs(b.booking_date_iso, b.booking_time);
    return startMs >= minMs && startMs <= maxMs;
  });

  const results = [];
  for (const booking of due) {
    const phone = toE164(booking.customer_phone);
    if (!phone) {
      results.push({ booking_id: booking.booking_id, skipped: 'invalid_phone' });
      continue;
    }
    try {
      await sendRespondMessage(phone, buildReminder(booking));
      const { error: updErr } = await supabase
        .from('express_bookings')
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq('booking_id', booking.booking_id);
      if (updErr) console.error('send-reminders: mark sent failed', booking.booking_id, updErr);
      results.push({ booking_id: booking.booking_id, sent: true });
    } catch (e) {
      console.error('send-reminders: send failed', booking.booking_id, e.message);
      results.push({ booking_id: booking.booking_id, sent: false, error: e.message });
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scanned:   candidates ? candidates.length : 0,
      due:       due.length,
      results,
    }),
  };
};
