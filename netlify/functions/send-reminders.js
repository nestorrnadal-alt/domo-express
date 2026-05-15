// ============================================================
// POST /api/send-reminders
//
// Cron-triggered (via GitHub Actions on a schedule — see
// .github/workflows/send-reminders.yml). Runs once a day at
// 8 AM PR time and sends a WhatsApp reminder via respond.io for
// every confirmed/unassigned booking happening "tomorrow" in PR
// time that hasn't been reminded yet.
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
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { mintBookingToken } = require('./_booking-token');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const PR_OFFSET_HOURS = -4;
const SITE_URL = process.env.SITE_URL || 'https://book.domoyourhome.com';

// Tomorrow's date in PR time, as an ISO date string. PR is UTC-4
// year-round (no DST), so "now in PR" = UTC now shifted by -4h.
// To get the ISO date of "tomorrow in PR", shift by (+24h - 4h) = +20h.
function tomorrowInPR() {
  return new Date(Date.now() + 20 * 3600 * 1000).toISOString().slice(0, 10);
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

  const targetDate = tomorrowInPR();

  const { data: candidates, error: fetchErr } = await supabase
    .from('express_bookings')
    .select('booking_id, customer_name, customer_phone, address, task_1, task_2, booking_date, booking_date_iso, booking_time, status')
    .eq('booking_date_iso', targetDate)
    .is('reminder_sent_at', null)
    .neq('status', 'cancelled');

  if (fetchErr) {
    console.error('send-reminders: supabase fetch error', fetchErr);
    return { statusCode: 500, body: JSON.stringify({ error: 'db_error', detail: fetchErr.message }) };
  }

  const results = [];
  for (const booking of (candidates || [])) {
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
      target_date: targetDate,
      scanned:     candidates ? candidates.length : 0,
      results,
    }),
  };
};
