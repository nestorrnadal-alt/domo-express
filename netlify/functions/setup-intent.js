// ============================================================
// Domo Express — Stripe SetupIntent
// Netlify Function: /api/setup-intent  (POST)
//
// Creates (or reuses) a Stripe Customer and returns a SetupIntent
// client_secret so the frontend can collect & save a card with
// Stripe.js. No charge is made — Domo captures payment after the
// service via a separate PaymentIntent off the saved payment method.
//
// Env vars (Netlify → Site config → Env vars):
//   STRIPE_SECRET_KEY     sk_test_… (or sk_live_… in prod)
// ============================================================

const Stripe = require('stripe');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Stripe is not configured on this site.' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { customer_email, customer_name, customer_phone } = body;
  if (!customer_email) {
    return { statusCode: 422, body: JSON.stringify({ error: 'customer_email is required' }) };
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  try {
    const existing = await stripe.customers.list({ email: customer_email, limit: 1 });
    const customer = existing.data[0]
      ? await stripe.customers.update(existing.data[0].id, {
          name:  customer_name  || existing.data[0].name  || undefined,
          phone: customer_phone || existing.data[0].phone || undefined,
        })
      : await stripe.customers.create({
          email: customer_email,
          name:  customer_name  || undefined,
          phone: customer_phone || undefined,
        });

    const setupIntent = await stripe.setupIntents.create({
      customer:             customer.id,
      payment_method_types: ['card'],
      usage:                'off_session',
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_secret: setupIntent.client_secret,
        customer_id:   customer.id,
      }),
    };
  } catch (err) {
    console.error('Stripe setup-intent error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Stripe error', detail: err.message }),
    };
  }
};
