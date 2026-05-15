// ============================================================
// Domo Express — Booking API
// Netlify Function: /api/book  (POST)
//
// What it does:
//   1. Validates the payload
//   2. Generates a unique booking ID (EXP-XXXX)
//   3. Inserts into Supabase express_bookings
//   4. Sends confirmation email to customer
//      FROM  info@domoyourhome.com
//      BCC   janet@domoyourhome.com, info@domoyourhome.com
//
// Environment variables required (set in Netlify UI → Site config → Env vars):
//   SUPABASE_URL          https://dowkxvpdpqqaufjqcjmp.supabase.co
//   SUPABASE_SERVICE_KEY  <service_role key from Supabase → Settings → API>
//   RESEND_API_KEY        <Resend API key — re_...>
//   RESEND_FROM           <verified sender, e.g. "Domo <book@domoyourhome.com>">
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { Resend }       = require('resend');
const { mintBookingToken } = require('./_booking-token');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// If RESEND_API_KEY isn't set, `resend` stays null and the function
// skips email sends gracefully — booking still succeeds.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM   = process.env.RESEND_FROM || 'Domo <onboarding@resend.dev>';

const SITE_URL = process.env.SITE_URL || 'https://book.domoyourhome.com';

function generateBookingId() {
  const num = Math.floor(1000 + Math.random() * 9000);
  return 'EXP-' + num;
}

function validate(body) {
  const required = [
    'customer_name','customer_phone','customer_email',
    'address','task_1','task_2',
    'booking_date','booking_time','payment_method','total_amount',
  ];
  for (const f of required) {
    if (!body[f]) return 'Missing required field: ' + f;
  }
  if (!['ath_movil','credit_card'].includes(body.payment_method)) {
    return 'Invalid payment_method. Must be ath_movil or credit_card.';
  }
  if (![17500, 20000].includes(Number(body.total_amount))) {
    return 'Invalid total_amount. Must be 17500 or 20000 (cents).';
  }
  if (body.payment_method === 'credit_card') {
    if (!body.stripe_customer_id || !body.stripe_payment_method_id) {
      return 'Missing Stripe IDs for credit_card payment.';
    }
  }
  return null;
}

function buildEmailHtml(data) {
  const price  = (data.total_amount / 100).toFixed(0);
  const payLbl = data.payment_method === 'ath_movil' ? 'ATH M\u00f3vil' : 'Tarjeta de cr\u00e9dito';
  const matRow = data.materials_requested
    ? '<tr><td style="color:#666;padding:6px 0">Materiales</td><td style="text-align:right;font-weight:600;padding:6px 0">Domo los consigue' + (data.materials_detail ? ' \u2014 ' + data.materials_detail : '') + '</td></tr>'
    : '';
  return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>'
    + '<body style="margin:0;padding:0;background:#f4f6fc">'
    + '<table width="100%" style="background:#f4f6fc;padding:32px 16px"><tr><td align="center">'
    + '<table width="100%" style="max-width:520px;background:#fff;border-radius:12px;border:1px solid #e0e4ef">'
    + '<tr><td style="background:#142543;padding:20px 28px">'
    + '<p style="margin:0;font-size:13px;font-weight:600;color:#80A2F9;text-transform:uppercase">Domo Express</p>'
    + '<p style="margin:4px 0 0;font-size:22px;font-weight:700;color:#fff">Reservaci\u00f3n confirmada</p></td></tr>'
    + '<tr><td style="background:#EEF1FA;padding:14px 28px;border-bottom:1px solid #d4daf0">'
    + '<p style="margin:0;font-size:13px;color:#4a5c8a">N\u00famero de reservaci\u00f3n</p>'
    + '<p style="margin:4px 0 0;font-size:24px;font-weight:700;color:#3652A5">' + data.booking_id + '</p></td></tr>'
    + '<tr><td style="padding:24px 28px">'
    + '<p style="margin:0 0 20px;font-size:14px;color:#444">Hola ' + data.customer_name + ', recibimos tu reservaci\u00f3n.</p>'
    + '<table width="100%" style="font-size:13px;border:1px solid #e0e4ef">'
    + '<tr><td style="color:#666;padding:6px 12px">Tareas</td><td style="text-align:right;font-weight:600;padding:6px 12px">' + data.task_1 + '<br>' + data.task_2 + '</td></tr>'
    + '<tr><td style="color:#666;padding:6px 12px">Fecha</td><td style="text-align:right;font-weight:600;padding:6px 12px">' + data.booking_date + '</td></tr>'
    + '<tr><td style="color:#666;padding:6px 12px">Hora</td><td style="text-align:right;font-weight:600;padding:6px 12px">' + data.booking_time + '</td></tr>'
    + '<tr><td style="color:#666;padding:6px 12px">Direcci\u00f3n</td><td style="text-align:right;font-weight:600;padding:6px 12px">' + data.address + '</td></tr>'
    + '<tr><td style="color:#666;padding:6px 12px">Pago</td><td style="text-align:right;font-weight:600;padding:6px 12px">' + payLbl + ' \u2014 despu\u00e9s del servicio</td></tr>'
    + matRow
    + '<tr style="background:#EEF1FA"><td style="padding:8px 12px;font-weight:700">Total</td><td style="text-align:right;font-weight:700;font-size:16px;padding:8px 12px;color:#3652A5">$' + price + '</td></tr>'
    + '</table>'
    + (data.reschedule_url
        ? '<table width="100%" style="margin-top:20px"><tr><td align="center">'
          + '<a href="' + data.reschedule_url + '" style="display:inline-block;background:#3652A5;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:14px;">Reprogramar o cancelar &rarr;</a>'
          + '</td></tr></table>'
        : '')
    + '<table width="100%" style="margin-top:16px;background:#FFF9E6;border-radius:8px;border:1px solid #f0d060">'
    + '<tr><td style="padding:12px 14px;font-size:13px;color:#5a4500">'
    + '<strong>Recuerda:</strong> Cambios y cancelaciones con al menos 24h de anticipo. Usa el botón de arriba o llama al (787) 419-0300.'
    + '</td></tr></table></td></tr>'
    + '<tr><td style="background:#f4f6fc;padding:16px 28px;border-top:1px solid #e0e4ef">'
    + '<p style="margin:0;font-size:12px;color:#999;text-align:center">Domo \u00b7 info@domoyourhome.com \u00b7 (787) 419-0300<br>San Juan, Puerto Rico</p>'
    + '</td></tr></table></td></tr></table></body></html>';
}

function buildEmailText(data) {
  const price  = (data.total_amount / 100).toFixed(0);
  const payLbl = data.payment_method === 'ath_movil' ? 'ATH M\u00f3vil' : 'Tarjeta de cr\u00e9dito';
  return [
    'DOMO EXPRESS \u2014 Reservaci\u00f3n ' + data.booking_id,
    '',
    'Hola ' + data.customer_name + ',',
    'Tu reservaci\u00f3n fue recibida.',
    '',
    'Tareas:   ' + data.task_1 + ' / ' + data.task_2,
    'Fecha:    ' + data.booking_date + ' a las ' + data.booking_time,
    'Direcci\u00f3n: ' + data.address,
    'Pago:     ' + payLbl + ' (despu\u00e9s del servicio)',
    data.materials_requested ? 'Materiales: Domo los consigue (+$30 gesti\u00f3n + costo real)' : null,
    'Total:    $' + price,
    '',
    data.reschedule_url ? 'Reprogramar o cancelar (24h+): ' + data.reschedule_url : null,
    'Tel\u00e9fono: (787) 419-0300 \u00b7 info@domoyourhome.com',
    '',
    '\u2014 Domo',
  ].filter(l => l !== null).join('\n');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const validationError = validate(body);
  if (validationError) {
    return { statusCode: 422, body: JSON.stringify({ error: validationError }) };
  }
  const booking_id = generateBookingId();
  const { error: dbError } = await supabase
    .from('express_bookings')
    .insert({
      booking_id,
      status:              'pending',
      customer_name:       body.customer_name,
      customer_phone:      body.customer_phone,
      customer_email:      body.customer_email,
      address:             body.address,
      task_1:              body.task_1,
      task_2:              body.task_2,
      booking_date:        body.booking_date,
      booking_date_iso:    body.booking_date_iso || null,
      booking_time:        body.booking_time,
      payment_method:           body.payment_method,
      materials_requested:      body.materials_requested || false,
      materials_detail:         body.materials_detail    || null,
      total_amount:             Number(body.total_amount),
      notes:                    body.notes               || null,
      stripe_customer_id:       body.stripe_customer_id       || null,
      stripe_payment_method_id: body.stripe_payment_method_id || null,
    });
  if (dbError) {
    console.error('Supabase insert error:', dbError);
    if (dbError.code === '23505') {
      return {
        statusCode: 409,
        body: JSON.stringify({
          error: 'Ese horario se acaba de reservar. Por favor escoge otra hora.',
          code:  'slot_taken',
        }),
      };
    }
    return { statusCode: 500, body: JSON.stringify({ error: 'Database error', detail: dbError.message }) };
  }
  // Reschedule token + URL \u2014 handed back to the client and embedded
  // in the confirmation email so customers can self-serve up to 24h
  // before the service.
  let reschedule_token = null;
  let reschedule_url   = null;
  try {
    reschedule_token = mintBookingToken(booking_id);
    reschedule_url   = `${SITE_URL}/reschedule.html?token=${encodeURIComponent(reschedule_token)}`;
  } catch (e) {
    console.error('book: minting reschedule token failed (ADMIN_JWT_SECRET set?):', e.message);
  }

  const data = { ...body, booking_id, reschedule_url };
  if (!resend) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id, reschedule_token, email_sent: false, warning: 'Resend not configured.' }),
    };
  }
  try {
    await resend.emails.send({
      from:    FROM,
      to:      [body.customer_email],
      bcc:     ['janet@domoyourhome.com', 'info@domoyourhome.com'],
      subject: 'Reservaci\u00f3n Domo Express ' + booking_id + ' \u2014 ' + body.booking_date,
      text:    buildEmailText(data),
      html:    buildEmailHtml(data),
    });
  } catch (mailError) {
    console.error('Email send error:', mailError);
    return {
      statusCode: 200,
      body: JSON.stringify({ booking_id, reschedule_token, email_sent: false, warning: 'Booking saved but email failed.' }),
    };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ booking_id, reschedule_token, email_sent: true }),
  };
};
