// ============================================================
// Domo Express — Public client config
// Netlify Function: /api/config  (GET)
//
// Exposes only values safe to ship to the browser: the Stripe
// publishable key. Returns an empty string if Stripe isn't
// configured so the frontend can hide the card option.
// ============================================================

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  return {
    statusCode: 200,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify({
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    }),
  };
};
