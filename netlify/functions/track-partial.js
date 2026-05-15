// ============================================================
// POST /api/track-partial
// Body: { customer_email, customer_phone, customer_name, address,
//         task_1, task_2, booking_date, booking_date_iso,
//         booking_time, payment_method, materials_requested,
//         materials_detail, total_amount }
//
// Called by the booking form when a customer transitions from
// step 4 (contact info + payment) to step 5 (review). At that
// point we have a complete-enough record to re-engage them if
// they bail before submitting.
//
// Upserts on lower(customer_email) — repeated abandons by the
// same person overwrite the previous partial.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'bad_json' }) }; }

  const email = String(body.customer_email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return { statusCode: 400, body: JSON.stringify({ error: 'email_required' }) };
  }

  const row = {
    customer_email:      email,
    customer_phone:      body.customer_phone || null,
    customer_name:       body.customer_name || null,
    address:             body.address || null,
    task_1:              body.task_1 || null,
    task_2:              body.task_2 || null,
    booking_date:        body.booking_date || null,
    booking_date_iso:    body.booking_date_iso || null,
    booking_time:        body.booking_time || null,
    payment_method:      body.payment_method || null,
    materials_requested: body.materials_requested || false,
    materials_detail:    body.materials_detail || null,
    total_amount:        Number.isFinite(body.total_amount) ? Math.round(body.total_amount) : null,
    updated_at:          new Date().toISOString(),
    // Reset notification timestamps on upsert: if they re-enter the
    // form after a previous abandon, treat it as a fresh capture and
    // give them a new chance to complete before re-emailing.
    recovery_emailed_at: null,
    ops_notified_at:     null,
  };

  const { error } = await supabase
    .from('express_partial_bookings')
    .upsert(row, { onConflict: 'customer_email', ignoreDuplicates: false });

  if (error) {
    // Some Postgres deployments index by lower(email); if upsert
    // can't match the constraint, fall back to update-by-email.
    if (error.code === '42P10' || /no unique/i.test(error.message || '')) {
      const { error: updErr } = await supabase
        .from('express_partial_bookings')
        .update(row)
        .ilike('customer_email', email);
      if (updErr) {
        console.error('track-partial: update fallback failed', updErr);
        return { statusCode: 500, body: JSON.stringify({ error: 'db_error' }) };
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true, mode: 'updated' }) };
    }
    console.error('track-partial: upsert failed', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'db_error', detail: error.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
