// ============================================================
// GET /api/admin/verify?token=...
//
// Validates a magic-link token. On success, mints a 30-day session
// token and sets it as an HttpOnly cookie, then 302-redirects to
// /admin.html.  On failure, redirects to /admin.html?error=invalid.
// ============================================================

const { verifyMagicLinkToken, mintSessionToken, sessionCookie } = require('./_admin-auth');

exports.handler = async (event) => {
  const token = (event.queryStringParameters || {}).token;
  const valid = verifyMagicLinkToken(token);

  if (!valid) {
    return {
      statusCode: 302,
      headers: { Location: '/admin.html?error=invalid' },
      body: '',
    };
  }

  const sessionToken = mintSessionToken(valid.email);
  return {
    statusCode: 302,
    headers: {
      Location: '/admin.html',
      'Set-Cookie': sessionCookie(sessionToken),
    },
    body: '',
  };
};
