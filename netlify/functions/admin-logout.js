// ============================================================
// POST /api/admin/logout
// Clears the admin session cookie. Always returns 200.
// ============================================================

const { clearCookie } = require('./_admin-auth');

exports.handler = async () => ({
  statusCode: 200,
  headers: {
    'Content-Type': 'application/json',
    'Set-Cookie':   clearCookie(),
  },
  body: JSON.stringify({ ok: true }),
});
