// ============================================================
// GET /api/google-reviews
//
// Fetches the latest reviews for the Domo business from Google's
// Places API (New) and serves them to the frontend testimonial
// carousel. Response is cached at the Netlify edge for 24 hours
// (s-maxage=86400) with a 7-day stale-while-revalidate so we don't
// hammer Google on every page load.
//
// Required env vars:
//   GOOGLE_PLACES_API_KEY    same key used for client autocomplete;
//                            "Places API (New)" must be enabled
// ============================================================

// Hardcoded business identity. Lat/lng come from the Google Maps
// listing URL the user shared. We text-search "Domo" with a tight
// location bias to deterministically resolve to this business
// (instead of any other "Domo" in the world).
const BUSINESS_QUERY = 'Domo';
const BUSINESS_LAT   = 18.3076466;
const BUSINESS_LNG   = -66.0050436;
const BUSINESS_RADIUS_M = 1000;

let cachedPlaceId      = null;
let cachedPlaceIdMs    = 0;
const PLACE_ID_TTL_MS  = 30 * 24 * 60 * 60 * 1000; // 30 days

async function resolvePlaceId(apiKey) {
  if (cachedPlaceId && (Date.now() - cachedPlaceIdMs) < PLACE_ID_TTL_MS) {
    return cachedPlaceId;
  }
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type':         'application/json',
      'X-Goog-Api-Key':       apiKey,
      'X-Goog-FieldMask':     'places.id,places.displayName',
    },
    body: JSON.stringify({
      textQuery: BUSINESS_QUERY,
      locationBias: {
        circle: {
          center: { latitude: BUSINESS_LAT, longitude: BUSINESS_LNG },
          radius: BUSINESS_RADIUS_M,
        },
      },
      maxResultCount: 1,
      languageCode: 'es',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('text-search ' + res.status + ': ' + text);
  }
  const data = await res.json();
  const first = (data.places || [])[0];
  if (!first || !first.id) throw new Error('no_place_match');
  cachedPlaceId   = first.id;
  cachedPlaceIdMs = Date.now();
  return cachedPlaceId;
}

async function fetchPlaceDetails(apiKey, placeId) {
  const res = await fetch(
    'https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId)
    + '?languageCode=es',
    {
      headers: {
        'X-Goog-Api-Key':   apiKey,
        'X-Goog-FieldMask': 'reviews,rating,userRatingCount,displayName',
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

  try {
    const placeId = await resolvePlaceId(apiKey);
    const details = await fetchPlaceDetails(apiKey, placeId);

    // Reduce Google's verbose review objects to just what the carousel needs.
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
        // Netlify edge caches the response for 24 hours; serves stale
        // for a week while a background refresh runs in the background.
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
      },
      body: JSON.stringify({
        rating:  details.rating || null,
        total:   details.userRatingCount || null,
        place:   (details.displayName && details.displayName.text) || null,
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
