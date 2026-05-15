// ============================================================
// POST /api/reschedule/update
// Body: { token, new_date_iso, new_time }
//
// Validates the booking token, checks the new slot is still
// available + at least 24h ahead, swaps the booking's
// booking_date_iso + booking_time + booking_date (label), and
// emails a fresh confirmation. Returns the updated booking.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { Resend }       = require('resend');
const { verifyBookingToken, mintBookingToken } = require('./_booking-token');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM   = process.env.RESEND_FROM || 'Domo <onboarding@resend.dev>';

const SITE_URL = process.env.SITE_URL || 'https://book.domoyourhome.com';

const PR_OFFSET_HOURS = -4;
const VALID_SLOTS = new Set(['8:00 AM','9:00 AM','10:00 AM','11:00 AM','1:00 PM']);

const DAY_LONG   = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
const MONTH_LONG = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

function dateLongLabel(iso) {
  const [Y, M, D] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(Y, M - 1, D));
  return `${DAY_LONG[d.getUTCDay()]}, ${D} de ${MONTH_LONG[M - 1]}`;
}
function slotHour24(slot) {
  const [time, period] = slot.split(' ');
  let [h, m] = time.split(':').map(Number);
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  return { h, m: m || 0 };
}
function slotUtcMs(isoDate, slot) {
  const [Y, M, D] = isoDate.split('-').map(Number);
  const { h, m } = slotHour24(slot);
  return Date.UTC(Y, M - 1, D, h - PR_OFFSET_HOURS, m);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'bad_json' }) }; }

  const valid = verifyBookingToken(body.token);
  if (!valid) {
    return { statusCode: 401, body: JSON.stringify({ error: 'invalid_or_expired_token' }) };
  }
  const newDate = String(body.new_date_iso || '').trim();
  const newTime = String(body.new_time     || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate) || !VALID_SLOTS.has(newTime)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_slot' }) };
  }

  // Must be at least 24h ahead.
  if (slotUtcMs(newDate, newTime) < Date.now() + 24 * 60 * 60 * 1000) {
    return { statusCode: 409, body: JSON.stringify({ error: 'too_close', message: 'Escoge un horario al menos 24h en el futuro.' }) };
  }

  // Booking must exist + not be cancelled.
  const { data: booking, error: fetchErr } = await supabase
    .from('express_bookings')
    .select('*')
    .eq('booking_id', valid.bookingId)
    .single();
  if (fetchErr || !booking) {
    return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  }
  if (booking.status === 'cancelled') {
    return { statusCode: 410, body: JSON.stringify({ error: 'already_cancelled' }) };
  }

  // Apply update. The partial unique index on
  // (booking_date_iso, booking_time) excluding cancelled rows
  // will reject collisions with a 23505 error.
  const newLabel = dateLongLabel(newDate);
  const { data: updated, error: updErr } = await supabase
    .from('express_bookings')
    .update({
      booking_date_iso: newDate,
      booking_time:     newTime,
      booking_date:     newLabel,
    })
    .eq('booking_id', valid.bookingId)
    .select()
    .single();

  if (updErr) {
    if (updErr.code === '23505') {
      return { statusCode: 409, body: JSON.stringify({ error: 'slot_taken', message: 'Ese horario se acaba de reservar. Escoge otro.' }) };
    }
    console.error('reschedule-update: supabase error', updErr);
    return { statusCode: 500, body: JSON.stringify({ error: 'db_error', detail: updErr.message }) };
  }

  // Email the new confirmation. Best-effort.
  if (resend) {
    const newToken = mintBookingToken(updated.booking_id);
    const reschedUrl = `${SITE_URL}/reschedule.html?token=${encodeURIComponent(newToken)}`;
    try {
      await resend.emails.send({
        from:    FROM,
        to:      [updated.customer_email],
        bcc:     ['janet@domoyourhome.com', 'info@domoyourhome.com'],
        subject: `Reservación Domo Express ${updated.booking_id} reprogramada — ${updated.booking_date}`,
        text:
          `Hola ${updated.customer_name},\n\n` +
          `Tu reservación ${updated.booking_id} se reprogramó.\n\n` +
          `Nueva fecha: ${updated.booking_date}\n` +
          `Nueva hora:  ${updated.booking_time} (servicio de 2.5h)\n\n` +
          `Si necesitas cambiar otra vez o cancelar:\n${reschedUrl}\n\n` +
          `¿Preguntas? (787) 419-0300 · info@domoyourhome.com\n\nDomo`,
        html:
          '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#142543;max-width:480px;">' +
          `<h2>Tu reservación se reprogramó</h2>` +
          `<p>Hola ${updated.customer_name},</p>` +
          `<p><strong>Nueva fecha:</strong> ${updated.booking_date}<br><strong>Nueva hora:</strong> ${updated.booking_time} (servicio de 2.5h)</p>` +
          `<p style="margin:18px 0;"><a href="${reschedUrl}" style="display:inline-block;background:#3652A5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Reprogramar o cancelar otra vez →</a></p>` +
          `<p style="font-size:12px;color:#6B7A99;">¿Preguntas? (787) 419-0300 · info@domoyourhome.com</p>` +
          '</div>',
      });
    } catch (e) {
      console.error('reschedule-update: email failed', e);
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, booking: updated }),
  };
};
