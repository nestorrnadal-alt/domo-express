// ============================================================
// Shared admin auth helpers — magic-link tokens + session cookies.
//
// Token format (used for both 15-min magic links and 30-day sessions):
//   <base64url(payload)>.<hex(hmac-sha256(secret, payload))>
//
//   where payload = "<email>|<expiry_unix_ms>|<purpose>"
//   purpose is "link" for one-time magic links, "session" for cookies.
//
// Tokens are HMAC-signed with ADMIN_JWT_SECRET. No JWT library; the
// surface is small enough that built-in `crypto` does the job.
//
// Required env vars (in Netlify):
//   ADMIN_JWT_SECRET  any long random string — sign + verify tokens
//   ADMIN_EMAILS      comma-separated allowlist, e.g.
//                     "janet@domoyourhome.com,info@domoyourhome.com"
// ============================================================

const crypto = require('crypto');

const COOKIE_NAME    = '__domo_admin';
const LINK_TTL_MS    = 15 * 60 * 1000;            // 15 min
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

function allowedEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedEmail(email) {
  if (!email) return false;
  return allowedEmails().includes(String(email).trim().toLowerCase());
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function sign(payload) {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) throw new Error('ADMIN_JWT_SECRET not set');
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function mintToken(email, ttlMs, purpose) {
  const exp     = Date.now() + ttlMs;
  const payload = `${email.toLowerCase()}|${exp}|${purpose}`;
  return `${b64url(payload)}.${sign(payload)}`;
}

function verifyToken(token, expectedPurpose) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  let payload;
  try { payload = b64urlDecode(encoded); } catch { return null; }
  const expectedSig = sign(payload);
  // constant-time compare
  if (sig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
    return null;
  }
  const [email, expStr, purpose] = payload.split('|');
  if (purpose !== expectedPurpose) return null;
  const exp = Number(expStr);
  if (!exp || Date.now() > exp) return null;
  if (!isAllowedEmail(email)) return null;
  return { email, exp };
}

function mintMagicLinkToken(email) {
  return mintToken(email, LINK_TTL_MS, 'link');
}
function mintSessionToken(email) {
  return mintToken(email, SESSION_TTL_MS, 'session');
}
function verifyMagicLinkToken(token) { return verifyToken(token, 'link'); }
function verifySessionToken(token)   { return verifyToken(token, 'session'); }

function sessionCookie(token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function readSessionFromHeaders(headers) {
  const raw = headers && (headers.cookie || headers.Cookie);
  if (!raw) return null;
  const m = String(raw).split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE_NAME}=`));
  if (!m) return null;
  const token = m.slice(COOKIE_NAME.length + 1);
  return verifySessionToken(token);
}

function requireSession(event) {
  const session = readSessionFromHeaders(event.headers || {});
  if (!session) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'unauthorized' }),
    };
  }
  return null; // null means: pass through, auth ok
}

module.exports = {
  COOKIE_NAME,
  isAllowedEmail,
  allowedEmails,
  mintMagicLinkToken,
  verifyMagicLinkToken,
  mintSessionToken,
  verifySessionToken,
  sessionCookie,
  clearCookie,
  readSessionFromHeaders,
  requireSession,
};
