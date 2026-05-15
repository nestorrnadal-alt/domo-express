// ============================================================
// Booking tokens — used for self-serve reschedule + cancel links.
//
// Token format mirrors _admin-auth.js:
//   <base64url(payload)>.<hex(hmac-sha256(secret, payload))>
//   payload = "<booking_id>|<exp_ms>|booking"
//
// Same secret as admin (ADMIN_JWT_SECRET) — simpler ops, and the
// blast radius of a leaked single-booking token is "the customer
// can reschedule their own booking," which is exactly what we want.
// ============================================================

const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function secret() {
  const s = process.env.ADMIN_JWT_SECRET;
  if (!s) throw new Error('ADMIN_JWT_SECRET not set');
  return s;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex');
}

// Token TTL: 60 days. The endpoint also re-checks the booking
// date and the 24h rule, so even a still-valid token can't be
// used to change a booking that's too close to its service time.
const DEFAULT_TTL_MS = 60 * 24 * 60 * 60 * 1000;

function mintBookingToken(bookingId, ttlMs) {
  const exp     = Date.now() + (ttlMs || DEFAULT_TTL_MS);
  const payload = `${bookingId}|${exp}|booking`;
  return `${b64url(payload)}.${sign(payload)}`;
}

function verifyBookingToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  let payload;
  try { payload = b64urlDecode(encoded); } catch { return null; }
  const expectedSig = sign(payload);
  if (sig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
    return null;
  }
  const [bookingId, expStr, purpose] = payload.split('|');
  if (purpose !== 'booking') return null;
  const exp = Number(expStr);
  if (!exp || Date.now() > exp) return null;
  if (!bookingId) return null;
  return { bookingId, exp };
}

module.exports = { mintBookingToken, verifyBookingToken };
