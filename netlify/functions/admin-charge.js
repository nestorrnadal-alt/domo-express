// ============================================================
// POST /api/admin/charge
// Body: { booking_id, amount? }
//
// Creates a Stripe PaymentIntent off the saved card for the
// booking, confirms it immediately, and writes the resulting state
// (charged_at, charged_amount, stripe_payment_intent_id) back to
// express_bookings.
//
// If `amount` is omitted, defaults to the booking's `total_amount`.
// Amounts are in cents.
//
// Refuses to charge a booking that is already charged or that is
// missing stripe_customer_id / stripe_payment_method_id.
// ============================================================

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { requireSession } = require('./_admin-auth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const unauthorized = requireSession(event);
  if (unauthorized) return unauthorized;

  if (!process.env.STRIPE_SECRET_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'stripe_not_configured' }) };
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'bad json' }) }; }

  const bookingId = String(body.booking_id || '').trim();
  if (!bookingId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'booking_id required' }) };
  }

  // Fetch booking
  const { data: booking, error: fetchErr } = await supabase
    .from('express_bookings')
    .select('booking_id, total_amount, charged_at, stripe_customer_id, stripe_payment_method_id, customer_email')
    .eq('booking_id', bookingId)
    .single();

  if (fetchErr || !booking) {
    return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  }
  if (booking.charged_at) {
    return { statusCode: 409, body: JSON.stringify({ error: 'already_charged', charged_at: booking.charged_at }) };
  }
  if (!booking.stripe_customer_id || !booking.stripe_payment_method_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'no_card_on_file' }) };
  }

  const amount = Number.isFinite(body.amount) ? Math.round(body.amount) : booking.total_amount;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_amount' }) };
  }

  // Create + confirm a PaymentIntent off the saved card.
  let intent;
  try {
    intent = await stripe.paymentIntents.create({
      amount,
      currency:       'usd',
      customer:       booking.stripe_customer_id,
      payment_method: booking.stripe_payment_method_id,
      off_session:    true,
      confirm:        true,
      description:    `Domo Express ${booking.booking_id}`,
      receipt_email:  booking.customer_email,
      metadata:       { booking_id: booking.booking_id },
    });
  } catch (e) {
    console.error('admin-charge: stripe error', e);
    return {
      statusCode: 402,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'stripe_error',
        code:  e.code || 'unknown',
        detail: e.message,
      }),
    };
  }

  if (intent.status !== 'succeeded') {
    return {
      statusCode: 402,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error:  'not_succeeded',
        status: intent.status,
        next_action: intent.next_action || null,
      }),
    };
  }

  // Record charge on the booking. Best-effort: if this fails we
  // still tell the caller the charge succeeded so Janet doesn't
  // double-charge.
  const { error: updateErr } = await supabase
    .from('express_bookings')
    .update({
      charged_at:               new Date().toISOString(),
      charged_amount:           amount,
      stripe_payment_intent_id: intent.id,
    })
    .eq('booking_id', bookingId);

  if (updateErr) {
    console.error('admin-charge: failed to record charge in DB', updateErr);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok:                       true,
      booking_id:               booking.booking_id,
      charged_amount:           amount,
      stripe_payment_intent_id: intent.id,
      db_recorded:              !updateErr,
    }),
  };
};
