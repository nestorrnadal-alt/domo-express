// ============================================================
// Shared helper: call the Google Analytics Data API v1beta
// (runReport) using a service-account credential from env.
//
// Hand-rolled JWT signing + token exchange so we don't have to
// bundle the heavy @google-analytics/data SDK into every function.
//
// Required env vars:
//   GA4_PROPERTY_ID            numeric GA4 property ID
//   GA4_SERVICE_ACCOUNT_B64    base64-encoded JSON key
// ============================================================

const crypto = require('crypto');

let cachedToken    = null;
let cachedTokenExp = 0;

function readCredentials() {
  const b64 = process.env.GA4_SERVICE_ACCOUNT_B64;
  if (!b64) return null;
  try {
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) {
    console.error('_ga4: GA4_SERVICE_ACCOUNT_B64 is not valid base64-encoded JSON', e.message);
    return null;
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function fetchAccessToken(credentials) {
  // Use cached token if still valid for at least 60 more seconds.
  if (cachedToken && cachedTokenExp - Date.now() > 60 * 1000) {
    return cachedToken;
  }

  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT', kid: credentials.private_key_id };
  const payload = {
    iss:   credentials.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  };

  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(credentials.private_key);
  const jwt = signingInput + '.' + b64url(signature);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('ga4 token exchange ' + res.status + ': ' + text);
  }
  const data = await res.json();
  cachedToken    = data.access_token;
  cachedTokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

async function runReport(body) {
  const credentials = readCredentials();
  if (!credentials) throw new Error('ga4_not_configured');
  if (!process.env.GA4_PROPERTY_ID) throw new Error('ga4_property_id_missing');

  const token = await fetchAccessToken(credentials);
  const url   = 'https://analyticsdata.googleapis.com/v1beta/properties/'
              + encodeURIComponent(process.env.GA4_PROPERTY_ID) + ':runReport';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('ga4 runReport ' + res.status + ': ' + text);
  }
  return res.json();
}

// Helper: fetch headline metrics for a date range, filtered to a
// specific hostname (so we measure book.domoyourhome.com only, not
// domoyourhome.com which shares the property).
async function fetchHostnameMetrics({ startDate, endDate, hostname }) {
  return runReport({
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'date' }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'screenPageViews' },
    ],
    dimensionFilter: {
      filter: {
        fieldName: 'hostName',
        stringFilter: { value: hostname, matchType: 'EXACT' },
      },
    },
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 100,
  });
}

// Helper: traffic source breakdown for a date range.
async function fetchSourceMetrics({ startDate, endDate, hostname }) {
  return runReport({
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: 'sessionSourceMedium' },
    ],
    metrics: [
      { name: 'sessions' },
      { name: 'conversions' },
    ],
    dimensionFilter: {
      filter: {
        fieldName: 'hostName',
        stringFilter: { value: hostname, matchType: 'EXACT' },
      },
    },
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 10,
  });
}

module.exports = {
  runReport,
  fetchHostnameMetrics,
  fetchSourceMetrics,
  isConfigured: () => Boolean(process.env.GA4_PROPERTY_ID && process.env.GA4_SERVICE_ACCOUNT_B64),
};
