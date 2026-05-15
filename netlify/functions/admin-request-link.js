// ============================================================
// POST /api/admin/request-link
// Body: { email }
//
// If the email is in the ADMIN_EMAILS allowlist, sends a magic-link
// email via Resend pointing at /admin?token=...  The token is good
// for 15 minutes.
//
// For security, the response is identical (200, generic message)
// whether or not the email was on the allowlist — that prevents
// enumeration of which addresses have admin access.
// ============================================================

const { Resend } = require('resend');
const { isAllowedEmail, mintMagicLinkToken } = require('./_admin-auth');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM   = process.env.RESEND_FROM || 'Domo <onboarding@resend.dev>';

const SITE_URL = process.env.SITE_URL || 'https://book.domoyourhome.com';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'bad json' }) }; }

  const email = String(body.email || '').trim().toLowerCase();

  const genericOk = {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, message: 'If that email is on the admin list, a sign-in link is on its way.' }),
  };

  if (!email || !isAllowedEmail(email)) {
    return genericOk;
  }

  if (!resend) {
    console.error('admin-request-link: RESEND_API_KEY not configured');
    return genericOk; // still return ok to avoid leaking config state
  }

  const token = mintMagicLinkToken(email);
  const url   = `${SITE_URL}/admin.html?token=${encodeURIComponent(token)}`;

  try {
    await resend.emails.send({
      from:    FROM,
      to:      [email],
      subject: 'Domo Admin — tu enlace para entrar',
      text:
        'Hola,\n\n' +
        'Haz clic en el siguiente enlace para entrar al panel de administración:\n\n' +
        url + '\n\n' +
        'Este enlace expira en 15 minutos y solo se puede usar una vez.\n\n' +
        'Si no solicitaste este correo, ignóralo.\n\nDomo',
      html:
        '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#142543;max-width:480px;">' +
        '<h2 style="color:#142543;">Domo Admin</h2>' +
        '<p>Haz clic en el botón para entrar al panel de administración:</p>' +
        '<p><a href="' + url + '" style="display:inline-block;background:#3652A5;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">Entrar al panel →</a></p>' +
        '<p style="font-size:12px;color:#6B7A99;">O copia este enlace al navegador:<br><code style="font-size:11px;word-break:break-all;">' + url + '</code></p>' +
        '<p style="font-size:12px;color:#6B7A99;">Expira en 15 minutos. Si no lo solicitaste, ignora este correo.</p>' +
        '</div>',
    });
  } catch (e) {
    console.error('admin-request-link: send failed', e);
    // still return generic ok — don't leak send failures to callers
  }

  return genericOk;
};
