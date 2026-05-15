// ============================================================
// POST /api/admin/update
// Body: { booking_id, status?, notes? }
//
// Updates the status and/or notes of a booking. Status must be one
// of: confirmed, completed, cancelled, no_show. Requires admin
// session cookie.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { requireSession } = require('./_admin-auth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const VALID_STATUSES = new Set(['confirmed', 'completed', 'cancelled', 'no_show']);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const unauthorized = requireSession(event);
  if (unauthorized) return unauthorized;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'bad json' }) }; }

  const bookingId = String(body.booking_id || '').trim();
  if (!bookingId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'booking_id required' }) };
  }

  const patch = {};
  if (body.status !== undefined) {
    if (!VALID_STATUSES.has(body.status)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'invalid status' }) };
    }
    patch.status = body.status;
  }
  if (body.notes !== undefined) {
    patch.notes = String(body.notes).slice(0, 2000) || null;
  }
  if (Object.keys(patch).length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'nothing to update' }) };
  }

  const { data, error } = await supabase
    .from('express_bookings')
    .update(patch)
    .eq('booking_id', bookingId)
    .select()
    .single();

  if (error) {
    console.error('admin-update: supabase error', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'db_error', detail: error.message }) };
  }
  if (!data) {
    return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, booking: data }),
  };
};
