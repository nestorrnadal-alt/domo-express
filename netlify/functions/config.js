// ============================================================
// Domo Express — Public client config
// Netlify Function: /api/config  (GET)
//
// Exposes only values safe to ship to the browser:
//   stripePublishableKey  — Stripe pk_live_ / pk_test_
//   googlePlacesApiKey    — Google Maps JS API key for address
//                           autocomplete (domain-restricted in the
//                           Google Cloud Console so even though
//                           it's served to the client it can only
//                           work from our domains)
// Returns empty strings when not configured so the frontend can
// degrade gracefully (hide the card option, skip autocomplete).
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
      googlePlacesApiKey:   process.env.GOOGLE_PLACES_API_KEY  || '',
    }),
  };
};
