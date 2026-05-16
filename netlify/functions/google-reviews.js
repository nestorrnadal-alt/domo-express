// ============================================================
// GET /api/google-reviews
//
// Fetches the latest reviews for the Domo business from Google's
// Places API (New) and serves them to the frontend testimonial
// carousel. Response is cached at the Netlify edge for 24 hours
// (s-maxage=86400) with a 7-day stale-while-revalidate.
//
// Resolution strategy: try a list of text queries in priority
// order, returning the first one that matches. Falls back to a
// pure phone-number search if nothing else hits.
//
// Required env vars:
//   GOOGLE_PLACES_API_KEY    same key used for client autocomplete;
//                            "Places API (New)" must be enabled
// Optional env vars:
//   GOOGLE_REVIEWS_QUERY     manual override — used first if set,
//                            so you can pin the exact query if
//                            Google's index drifts
// ============================================================

let cachedPlaceId      = null;
let cachedPlaceIdMs    = 0;
const PLACE_ID_TTL_MS  = 30 * 24 * 60 * 60 * 1000; // 30 days

async function searchText(query, apiKey, opts) {
  const body = { textQuery: query, maxResultCount: 1, languageCode: 'es' };
  if (opts && opts.locationBias) body.locationBias = opts.locationBias;
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'X-Goog-Api-Key':   apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('text-search ' + res.status + ': ' + text);
  }
  const data = await res.json();
  const first = (data.places || [])[0];
  return first || null;
}

async function resolvePlaceId(apiKey) {
  if (cachedPlaceId && (Date.now() - cachedPlaceIdMs) < PLACE_ID_TTL_MS) {
    return cachedPlaceId;
  }

  // Try queries in order, stopping on first match. Most-specific first.
  const candidates = [
    process.env.GOOGLE_REVIEWS_QUERY,
    'Domo home help service agency Puerto Rico',
    'domoyourhome.com',
    'Domo handyman Puerto Rico',
    'Domo +17874190300',
    '+17874190300',
  ].filter(Boolean);

  let lastErr = null;
  for (const q of candidates) {
    try {
      const place = await searchText(q, apiKey);
      if (place && place.id) {
        cachedPlaceId   = place.id;
        cachedPlaceIdMs = Date.now();
        console.log('google-reviews: resolved via query', JSON.stringify(q), '->', place.displayName && place.displayName.text);
        return cachedPlaceId;
      }
    } catch (e) {
      lastErr = e;
      console.log('google-reviews: query failed', JSON.stringify(q), e.message);
    }
  }
  throw lastErr || new Error('no_place_match');
}

async function fetchPlaceDetails(apiKey, placeId) {
  const res = await fetch(
    'https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId)
    + '?languageCode=es',
    {
      headers: {
        'X-Goog-Api-Key':   apiKey,
        'X-Goog-FieldMask': 'reviews,rating,userRatingCount,displayName,formattedAddress',
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('place-details ' + res.status + ': ' + text);
  }
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ reviews: [], configured: false }),
    };
  }

  // The `debug=1` query param bypasses the resolved-place-id cache so
  // we can iterate on the query without redeploying.
  if ((event.queryStringParameters || {}).debug) {
    cachedPlaceId = null;
  }

  try {
    const placeId = await resolvePlaceId(apiKey);
    const details = await fetchPlaceDetails(apiKey, placeId);

    const reviews = (details.reviews || []).slice(0, 5).map(r => ({
      author:   r.authorAttribution && r.authorAttribution.displayName ? r.authorAttribution.displayName : 'Cliente',
      photo:    r.authorAttribution && r.authorAttribution.photoUri ? r.authorAttribution.photoUri : null,
      rating:   r.rating || 5,
      text:     (r.text && r.text.text) || (r.originalText && r.originalText.text) || '',
      relative: r.relativePublishTimeDescription || '',
    })).filter(r => r.text);

    return {
      statusCode: 200,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
      },
      body: JSON.stringify({
        rating:  details.rating || null,
        total:   details.userRatingCount || null,
        place:   (details.displayName && details.displayName.text) || null,
        address: details.formattedAddress || null,
        reviews,
      }),
    };
  } catch (e) {
    console.error('google-reviews failed', e.message);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ reviews: [], error: e.message }),
    };
  }
};
