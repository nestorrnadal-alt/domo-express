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
//   OUTLOOK_USER          info@domoyourhome.com
//   OUTLOOK_PASS          <Outlook / Microsoft 365 app password>
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const nodemailer        = require('nodemailer');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const transporter = nodemailer.createTransport({
  host:   'smtp.office365.com',
  port:   587,
  secure: false,
  auth: {
    user: process.env.OUTLOOK_USER,
    pass: process.env.OUTLOOK_PASS,
  },
  tls: { ciphers: 'SSLv3' },
});

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
  if (![14900, 17900].includes(Number(body.total_amount))) {
    return 'Invalid total_amount. Must be 14900 or 17900 (cents).';
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
    + '<table width="100%" style="margin-top:20px;background:#FFF9E6;border-radius:8px;border:1px solid #f0d060">'
    + '<tr><td style="padding:12px 14px;font-size:13px;color:#5a4500">'
    + '<strong>Recuerda:</strong> Cancela con 24h de anticipo respondiendo este correo o al (787) 419-0300.'
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
    'Cancelaciones 24h+: info@domoyourhome.com | (787) 419-0300',
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
      booking_time:        body.booking_time,
      payment_method:      body.payment_method,
      materials_requested: body.materials_requested || false,
      materials_detail:    body.materials_detail    || null,
      total_amount:        Number(body.total_amount),
      notes:               body.notes               || null,
    });
  if (dbError) {
    console.error('Supabase insert error:', dbError);
    return { statusCode: 500, body: JSON.stringify({ error: 'Database error', detail: dbError.message }) };
  }
  const data = { ...body, booking_id };
  try {
    await transporter.sendMail({
      from:    '"Domo" <' + process.env.OUTLOOK_USER + '>',
      to:      body.customer_email,
      bcc:     'janet@domoyourhome.com,info@domoyourhome.com',
      subject: 'Reservaci\u00f3n Domo Express ' + booking_id + ' \u2014 ' + body.booking_date,
      text:    buildEmailText(data),
      html:    buildEmailHtml(data),
    });
  } catch (mailError) {
    console.error('Email send error:', mailError);
    return {
      statusCode: 200,
      body: JSON.stringify({ booking_id, email_sent: false, warning: 'Booking saved but email failed.' }),
    };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ booking_id, email_sent: true }),
  };
};
