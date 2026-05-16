// ============================================================
// GET /api/google-reviews
//
// Fetches the latest reviews for the Domo business from Google's
// Places API (New). Response cached at the Netlify edge for 24h
// (s-maxage=86400) with a 7-day stale-while-revalidate.
//
// Resolution strategy (in order):
//   1. GOOGLE_REVIEWS_PLACE_ID env var (manual override — paste
//      a ChIJ... Place ID once you have one).
//   2. CID-redirect lookup. The CID is the trailing hex in the
//      FTID from the Google Maps URL the user shared:
//      0x8c1efe8650d0b9ad:0xd99a22ecab0a558b → CID 0xd99a22ecab0a558b.
//      https://www.google.com/maps?cid=<decimal> redirects to a
//      Google Maps URL that contains the ChIJ... Place ID; we
//      parse it out of the response.
//   3. Text-search fallback (kept as a last resort if the redirect
//      method breaks).
// ============================================================

// The trailing hex of the FTID from the user's Google Maps URL,
// converted to decimal via BigInt (the raw value overflows Number).
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
  // Follow the Google Maps CID redirect and pull the ChIJ Place ID
  // out of the final URL. Works without an API key because it's just
  // a public Maps URL — but we run it server-side so the response
  // body (small HTML) doesn't go to the browser.
  const res = await fetch('https://www.google.com/maps?cid=' + FTID_CID_DEC, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const finalUrl = res.url || '';
  // Match patterns like "!1s0x...:0xChIJ..." or "!1sChIJ..." or "/place/.../@.../data=...!1sChIJ..."
  let m = finalUrl.match(/[!\/\?&]1s(ChIJ[A-Za-z0-9_-]+)/);
  if (m) return m[1];
  // Sometimes the redirect lands at a URL with no ChIJ; the HTML
  // body of /maps?cid=... usually contains a meta or script tag
  // with the Place ID. Cheap regex over the body as a last resort.
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
  if (cachedPlaceId && (Date.now() - cachedPlaceIdMs) < PLACE_ID_TTL_MS) {
    return cachedPlaceId;
  }

  // 1. Manual override
  if (process.env.GOOGLE_REVIEWS_PLACE_ID) {
    return cachePlaceId(process.env.GOOGLE_REVIEWS_PLACE_ID);
  }

  // 2. CID redirect (deterministic; uses the FTID from the Maps URL)
  try {
    const id = await placeIdFromCid();
    if (id) {
      console.log('google-reviews: resolved via CID redirect ->', id);
      return cachePlaceId(id);
    }
  } catch (e) {
    console.log('google-reviews: cid redirect failed', e.message);
  }

  // 3. Text-search fallback
  const candidates = [
    process.env.GOOGLE_REVIEWS_QUERY,
    'Domo home help service agency Puerto Rico',
    'domoyourhome.com',
    'Domo handyman Puerto Rico',
    '+17874190300',
  ].filter(Boolean);

  for (const q of candidates) {
    try {
      const place = await searchText(q, apiKey);
      if (place && place.id) {
        console.log('google-reviews: resolved via query', JSON.stringify(q), '->', place.displayName && place.displayName.text);
        return cachePlaceId(place.id);
      }
    } catch (e) {
      console.log('google-reviews: query failed', JSON.stringify(q), e.message);
    }
  }
  throw new Error('no_place_match');
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
        rating:    details.rating || null,
        total:     details.userRatingCount || null,
        place:     (details.displayName && details.displayName.text) || null,
        address:   details.formattedAddress || null,
        place_id:  placeId,
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
