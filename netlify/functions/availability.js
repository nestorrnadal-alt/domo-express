// ============================================================
// Domo Express — Availability
// Netlify Function: /api/availability  (GET)
//
// Returns the open dates + slots for the next 14 days in Puerto
// Rico time (UTC-4, no DST). A slot is open if:
//   1. It's at least 24h from now.
//   2. The date isn't a Saturday or Sunday.
//   3. There's no full-day or matching-slot row in
//      express_schedule_blackouts.
//   4. There's no row in express_bookings for that date + slot.
//
// Response shape:
//   { dates: [ { iso, slots: [string,...] }, ... ] }
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const PR_OFFSET_HOURS = -4;
const LEAD_TIME_MS    = 24 * 60 * 60 * 1000;
const WINDOW_DAYS     = 14;

const SLOTS = [
  '8:00 AM','9:00 AM','10:00 AM','11:00 AM',
  '1:00 PM','2:00 PM','3:00 PM','4:00 PM',
];

function slotHour24(slot) {
  const [time, period] = slot.split(' ');
  let [h, m] = time.split(':').map(Number);
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  return { h, m: m || 0 };
}

// UTC millis for a given PR clock time on an ISO date.
// PR is UTC-4 → PR hh:mm == UTC (hh + 4):mm.
function slotUtcMs(isoDate, slot) {
  const [Y, M, D] = isoDate.split('-').map(Number);
  const { h, m }  = slotHour24(slot);
  return Date.UTC(Y, M - 1, D, h - PR_OFFSET_HOURS, m);
}

function prTodayIso() {
  const prMs = Date.now() + PR_OFFSET_HOURS * 3600 * 1000;
  const pr   = new Date(prMs);
  const Y = pr.getUTCFullYear();
  const M = String(pr.getUTCMonth() + 1).padStart(2, '0');
  const D = String(pr.getUTCDate()).padStart(2, '0');
  return `${Y}-${M}-${D}`;
}

function addDaysIso(isoDate, days) {
  const [Y, M, D] = isoDate.split('-').map(Number);
  const ts = Date.UTC(Y, M - 1, D) + days * 86400 * 1000;
  const d  = new Date(ts);
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function isWeekend(isoDate) {
  const [Y, M, D] = isoDate.split('-').map(Number);
  const dow = new Date(Date.UTC(Y, M - 1, D)).getUTCDay();
  return dow === 0 || dow === 6;
}

exports.handler = async () => {
  const today    = prTodayIso();
  const lastDate = addDaysIso(today, WINDOW_DAYS);
  const cutoffMs = Date.now() + LEAD_TIME_MS;

  // Pull blackouts + bookings inside the window in parallel.
  const [blackoutRes, bookingRes] = await Promise.all([
    supabase
      .from('express_schedule_blackouts')
      .select('blackout_date, blackout_slot')
      .gte('blackout_date', today)
      .lte('blackout_date', lastDate),
    supabase
      .from('express_bookings')
      .select('booking_date_iso, booking_time')
      .gte('booking_date_iso', today)
      .lte('booking_date_iso', lastDate)
      .neq('status', 'cancelled'),
  ]);

  if (blackoutRes.error) {
    console.error('availability: blackouts error', blackoutRes.error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not load schedule.' }) };
  }
  if (bookingRes.error) {
    console.error('availability: bookings error', bookingRes.error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not load bookings.' }) };
  }

  const blockedFullDay = new Set();
  const blockedSlot    = new Set(); // key = `${iso}|${slot}`
  for (const row of blackoutRes.data) {
    if (row.blackout_slot) blockedSlot.add(`${row.blackout_date}|${row.blackout_slot}`);
    else                   blockedFullDay.add(row.blackout_date);
  }
  for (const row of bookingRes.data) {
    if (row.booking_date_iso && row.booking_time) {
      blockedSlot.add(`${row.booking_date_iso}|${row.booking_time}`);
    }
  }

  const dates = [];
  for (let i = 1; i <= WINDOW_DAYS; i++) {
    const iso = addDaysIso(today, i);
    if (isWeekend(iso))           continue;
    if (blockedFullDay.has(iso))  continue;

    const slots = SLOTS.filter(slot => {
      if (blockedSlot.has(`${iso}|${slot}`)) return false;
      if (slotUtcMs(iso, slot) < cutoffMs)   return false;
      return true;
    });

    if (slots.length) dates.push({ iso, slots });
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify({ dates }),
  };
};
