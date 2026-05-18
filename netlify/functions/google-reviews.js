// ============================================================
// GET /api/google-reviews
//
// Currently serves a HARDCODED rating + review snapshot for the
// Domo Google Business listing because the Places API resolution
// from the FTID / text search has not been reliable for this
// listing. The numbers reflect the snapshot from Néstor's GBP
// dashboard on 2026-05-18 (5.0 stars, 11 reviews).
//
// To add real review text later: paste 3-5 reviews into the
// HARDCODED_REVIEWS array below as { author, rating, text,
// relative } objects. The frontend already renders them
// identically to API-sourced reviews.
//
// When/if the Places API path becomes reliable (we get a working
// Place ID), we can flip USE_API back to true.
// ============================================================

const USE_API = false;

const HARDCODED_RATING = 5.0;
const HARDCODED_TOTAL  = 11;
const HARDCODED_REVIEWS = [
  {
    author:   'Lourdes Cardona',
    rating:   5,
    text:     '¡Excelente servicio! 100% recomendado.',
    relative: 'hace 4 semanas',
  },
  {
    author:   'Marta Aponte',
    rating:   5,
    text:     'Se comunicaron el día antes para confirmar qué trabajo se iban a realizar y orientarme sobre qué materiales debía…',
    relative: 'hace 3 meses',
  },
  {
    author:   'Ángel',
    rating:   5,
    text:     'Extraordinary.',
    relative: 'hace 7 semanas',
  },
];

// ----- below this line: API path, kept for the eventual swap -----

const FTID_CID_HEX  = '0xd99a22ecab0a558b';
const FTID_CID_DEC  = BigInt(FTID_CID_HEX).toString();

let cachedPlaceId   = null;
let cachedPlaceIdMs = 0;
const PLACE_ID_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function cachePlaceId(id) {
  cachedPlaceId = id;
  cachedPlaceIdMs = Date.now();
  return id;
}

async function placeIdFromCid() {
  const res = await fetch('https://www.google.com/maps?cid=' + FTID_CID_DEC, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const finalUrl = res.url || '';
  let m = finalUrl.match(/[!\/\?&]1s(ChIJ[A-Za-z0-9_-]+)/);
  if (m) return m[1];
  let html = '';
  try { html = await res.text(); } catch {}
  m = html.match(/\b(ChIJ[A-Za-z0-9_-]{10,})\b/);
  return m ? m[1] : null;
}

async function searchText(query, apiKey) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'X-Goog-Api-Key':   apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress',
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 1, languageCode: 'es' }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('text-search ' + res.status + ': ' + text);
  }
  const data = await res.json();
  return (data.places || [])[0] || null;
}

async function resolvePlaceId(apiKey) {
  if (cachedPlaceId && (Date.now() - cachedPlaceIdMs) < PLACE_ID_TTL_MS) return cachedPlaceId;
  if (process.env.GOOGLE_REVIEWS_PLACE_ID) return cachePlaceId(process.env.GOOGLE_REVIEWS_PLACE_ID);
  try {
    const id = await placeIdFromCid();
    if (id) return cachePlaceId(id);
  } catch {}
  const candidates = [
    process.env.GOOGLE_REVIEWS_QUERY,
    'Domo home help service agency Puerto Rico',
    'domoyourhome.com',
    '+17874190300',
  ].filter(Boolean);
  for (const q of candidates) {
    try { const place = await searchText(q, apiKey); if (place && place.id) return cachePlaceId(place.id); }
    catch {}
  }
  throw new Error('no_place_match');
}

async function fetchPlaceDetails(apiKey, placeId) {
  const res = await fetch(
    'https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId) + '?languageCode=es',
    { headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'reviews,rating,userRatingCount,displayName,formattedAddress' } },
  );
  if (!res.ok) throw new Error('place-details ' + res.status);
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  if (!USE_API) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800' },
      body: JSON.stringify({
        rating:  HARDCODED_RATING,
        total:   HARDCODED_TOTAL,
        place:   'Domo',
        reviews: HARDCODED_REVIEWS,
        source:  'hardcoded',
      }),
    };
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ reviews: [], configured: false }) };
  }
  if ((event.queryStringParameters || {}).debug) cachedPlaceId = null;

  try {
    const placeId = await resolvePlaceId(apiKey);
    const details = await fetchPlaceDetails(apiKey, placeId);
    const reviews = (details.reviews || []).slice(0, 5).map(r => ({
      author:   r.authorAttribution && r.authorAttribution.displayName ? r.authorAttribution.displayName : 'Cliente',
      rating:   r.rating || 5,
      text:     (r.text && r.text.text) || (r.originalText && r.originalText.text) || '',
      relative: r.relativePublishTimeDescription || '',
    })).filter(r => r.text);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800' },
      body: JSON.stringify({
        rating:    details.rating || HARDCODED_RATING,
        total:     details.userRatingCount || HARDCODED_TOTAL,
        place:     (details.displayName && details.displayName.text) || 'Domo',
        place_id:  placeId,
        reviews,
        source:    'api',
      }),
    };
  } catch (e) {
    console.error('google-reviews api fallback', e.message);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=3600' },
      body: JSON.stringify({ rating: HARDCODED_RATING, total: HARDCODED_TOTAL, place: 'Domo', reviews: HARDCODED_REVIEWS, source: 'hardcoded-fallback', error: e.message }),
    };
  }
};
