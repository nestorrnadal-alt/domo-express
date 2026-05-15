// ============================================================
// GET /api/admin/bookings?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Returns all express_bookings rows in the date range, ordered by
// date + time. Requires a valid admin session cookie.
//
// If no range is given, defaults to (today - 7d) → (today + 30d).
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { requireSession } = require('./_admin-auth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

function todayIso() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}
function shiftIso(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const unauthorized = requireSession(event);
  if (unauthorized) return unauthorized;

  const qs   = event.queryStringParameters || {};
  const from = qs.from || shiftIso(todayIso(), -7);
  const to   = qs.to   || shiftIso(todayIso(),  30);

  const { data, error } = await supabase
    .from('express_bookings')
    .select(`
      booking_id, status, created_at,
      customer_name, customer_phone, customer_email, address,
      task_1, task_2,
      booking_date, booking_date_iso, booking_time,
      payment_method, materials_requested, materials_detail,
      total_amount, charged_at, charged_amount, stripe_payment_intent_id,
      stripe_customer_id, stripe_payment_method_id, bk_booking_id, notes
    `)
    .gte('booking_date_iso', from)
    .lte('booking_date_iso', to)
    .order('booking_date_iso', { ascending: true })
    .order('booking_time',     { ascending: true });

  if (error) {
    console.error('admin-bookings: supabase error', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'db_error', detail: error.message }),
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ from, to, bookings: data || [] }),
  };
};
