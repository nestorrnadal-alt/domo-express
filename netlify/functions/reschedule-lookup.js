// ============================================================
// GET /api/reschedule/lookup?token=...
//
// Token-authenticated lookup. Returns the booking the token points
// to + the same availability payload /api/availability would return
// (so reschedule.html can render its own date/time picker without
// a second round-trip).
//
// Refuses if:
//   - Token invalid / expired
//   - Booking not found
//   - Booking already cancelled
//   - Service time is < 24h from now (too late to self-serve)
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { verifyBookingToken } = require('./_booking-token');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const PR_OFFSET_HOURS = -4;
const SLOTS = ['8:00 AM','11:00 AM','2:00 PM'];

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
function todayInPR() {
  const now = new Date();
  const prTs = now.getTime() + PR_OFFSET_HOURS * 3600 * 1000;
  const d = new Date(prTs);
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
function shiftIso(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function isWeekendIso(iso) {
  const [Y, M, D] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(Y, M - 1, D)).getUTCDay();
  return dow === 0 || dow === 6;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const token = (event.queryStringParameters || {}).token;
  const valid = verifyBookingToken(token);
  if (!valid) {
    return { statusCode: 401, body: JSON.stringify({ error: 'invalid_or_expired_token' }) };
  }

  const { data: booking, error } = await supabase
    .from('express_bookings')
    .select('booking_id, customer_name, customer_email, booking_date, booking_date_iso, booking_time, task_1, task_2, status, total_amount')
    .eq('booking_id', valid.bookingId)
    .single();

  if (error || !booking) {
    return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  }
  if (booking.status === 'cancelled') {
    return { statusCode: 410, body: JSON.stringify({ error: 'already_cancelled' }) };
  }

  // 24-hour lead-time check: refuse self-serve if service is too close.
  const serviceMs = slotUtcMs(booking.booking_date_iso, booking.booking_time);
  const cutoffMs  = Date.now() + 24 * 60 * 60 * 1000;
  if (serviceMs < cutoffMs) {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: 'too_close',
        message: 'Tu servicio es en menos de 24 horas. Llama al (787) 419-0300 para cambios.',
      }),
    };
  }

  // Build a 14-day availability snapshot. Mirrors /api/availability
  // but inlined here so reschedule.html only does one round-trip.
  const startIso = todayInPR();
  const cutoffSlotMs = cutoffMs;

  // Booked slots in the window — exclude this booking itself so the
  // customer can stay on the same slot if they change their mind.
  const endIso = shiftIso(startIso, 14);
  const [{ data: blackouts = [] }, { data: bookings = [] }] = await Promise.all([
    supabase.from('express_schedule_blackouts')
      .select('blackout_date, blackout_slot')
      .gte('blackout_date', startIso)
      .lte('blackout_date', endIso),
    supabase.from('express_bookings')
      .select('booking_date_iso, booking_time, status, booking_id')
      .gte('booking_date_iso', startIso)
      .lte('booking_date_iso', endIso)
      .neq('status', 'cancelled'),
  ]);

  const blockedDay  = new Set();
  const blockedSlot = new Set();
  blackouts.forEach(b => {
    if (!b.blackout_slot) blockedDay.add(b.blackout_date);
    else                  blockedSlot.add(`${b.blackout_date}|${b.blackout_slot}`);
  });
  bookings.forEach(b => {
    if (b.booking_id === booking.booking_id) return; // skip self
    if (b.booking_date_iso && b.booking_time) {
      blockedSlot.add(`${b.booking_date_iso}|${b.booking_time}`);
    }
  });

  const dates = [];
  for (let i = 0; i < 14; i++) {
    const iso = shiftIso(startIso, i);
    if (isWeekendIso(iso)) continue;
    if (blockedDay.has(iso)) continue;
    const openSlots = SLOTS.filter(slot => {
      if (blockedSlot.has(`${iso}|${slot}`)) return false;
      if (slotUtcMs(iso, slot) < cutoffSlotMs)  return false;
      return true;
    });
    if (openSlots.length) dates.push({ iso, slots: openSlots });
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ booking, dates }),
  };
};
