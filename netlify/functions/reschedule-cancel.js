// ============================================================
// POST /api/reschedule/cancel
// Body: { token }
//
// Validates booking token + 24h lead time, flips status to
// 'cancelled', emails the customer + ops a cancellation notice.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { Resend }       = require('resend');
const { verifyBookingToken } = require('./_booking-token');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM   = process.env.RESEND_FROM || 'Domo <onboarding@resend.dev>';

const PR_OFFSET_HOURS = -4;
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

  const { data: booking, error: fetchErr } = await supabase
    .from('express_bookings')
    .select('*')
    .eq('booking_id', valid.bookingId)
    .single();
  if (fetchErr || !booking) {
    return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  }
  if (booking.status === 'cancelled') {
    return { statusCode: 200, body: JSON.stringify({ ok: true, already_cancelled: true }) };
  }
  if (slotUtcMs(booking.booking_date_iso, booking.booking_time) < Date.now() + 24 * 60 * 60 * 1000) {
    return { statusCode: 409, body: JSON.stringify({ error: 'too_close', message: 'Tu servicio es en menos de 24 horas. Llama al (787) 419-0300.' }) };
  }

  const { data: updated, error: updErr } = await supabase
    .from('express_bookings')
    .update({ status: 'cancelled' })
    .eq('booking_id', valid.bookingId)
    .select()
    .single();
  if (updErr) {
    return { statusCode: 500, body: JSON.stringify({ error: 'db_error', detail: updErr.message }) };
  }

  if (resend) {
    try {
      await resend.emails.send({
        from:    FROM,
        to:      [updated.customer_email],
        bcc:     ['janet@domoyourhome.com', 'info@domoyourhome.com'],
        subject: `Reservación Domo Express ${updated.booking_id} cancelada`,
        text:
          `Hola ${updated.customer_name},\n\n` +
          `Tu reservación ${updated.booking_id} se canceló a tu solicitud.\n\n` +
          `Si fue un error o quieres una nueva fecha, escríbenos a info@domoyourhome.com o llama al (787) 419-0300.\n\nDomo`,
        html:
          '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#142543;max-width:480px;">' +
          `<h2>Reservación cancelada</h2>` +
          `<p>Hola ${updated.customer_name}, tu reservación <strong>${updated.booking_id}</strong> se canceló a tu solicitud.</p>` +
          `<p style="font-size:13px;color:#6B7A99;">Si fue un error, escríbenos a info@domoyourhome.com o llama al (787) 419-0300.</p>` +
          '</div>',
      });
    } catch (e) {
      console.error('reschedule-cancel: email failed', e);
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, booking: updated }),
  };
};
