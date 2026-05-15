// ============================================================
// POST /api/recover-abandoned
//
// Cron-triggered (GitHub Actions). For each express_partial_bookings
// row older than 30 minutes that hasn't been notified yet:
//   1. Skip if a matching express_bookings exists with a created_at
//      after the partial's updated_at (= the customer completed the
//      booking; their partial is just stale).
//   2. Otherwise, send a friendly recovery email to the customer
//      AND a "abandoned booking" notification to ops with the full
//      contact details so Janet can call them.
//   3. Stamp recovery_emailed_at + ops_notified_at so we don't
//      re-fire on the same row.
//
// Auth: x-cron-secret header must match CRON_SECRET env var.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { Resend }       = require('resend');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM   = process.env.RESEND_FROM || 'Domo <onboarding@resend.dev>';
const SITE_URL = process.env.SITE_URL || 'https://book.domoyourhome.com';

const ABANDON_AFTER_MS = 30 * 60 * 1000;

async function customerHasCompleted(email, since) {
  // True if there's an express_bookings row for this email created
  // after the partial's last update. We check status != cancelled
  // so a partial isn't suppressed by a stale cancelled booking.
  const { data, error } = await supabase
    .from('express_bookings')
    .select('booking_id', { count: 'exact', head: true })
    .ilike('customer_email', email)
    .gte('created_at', since)
    .neq('status', 'cancelled')
    .limit(1);
  if (error) {
    console.error('recover-abandoned: completion check failed', error);
    return false; // be conservative — send the email rather than skip
  }
  return (data && data.length > 0);
}

function buildCustomerEmail(p) {
  const url = SITE_URL + '/';
  return {
    subject: '¿Te ayudamos a terminar tu reservación de Domo Express?',
    text:
      `Hola ${p.customer_name || ''},\n\n` +
      `Notamos que empezaste a reservar tu Domo Express y no terminaste. ` +
      `Si necesitas ayuda o tienes preguntas, llámanos al (787) 419-0300 o respóndenos por WhatsApp.\n\n` +
      `Si quieres terminar la reservación tú mismo, todo lo que tienes es:\n` +
      (p.task_1 ? `Tareas: ${p.task_1}${p.task_2 ? ' y ' + p.task_2 : ''}\n` : '') +
      (p.booking_date ? `Fecha: ${p.booking_date}\n` : '') +
      (p.booking_time ? `Hora:  ${p.booking_time}\n` : '') +
      `Total: $${((p.total_amount || 17500) / 100).toFixed(0)}\n\n` +
      `Termina aquí: ${url}\n\n— Domo`,
    html:
      '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#142543;max-width:480px;">' +
      `<h2 style="color:#142543;">¿Te ayudamos a terminar?</h2>` +
      `<p>Hola ${p.customer_name || ''}, notamos que empezaste a reservar tu Domo Express y no terminaste.</p>` +
      (p.task_1 || p.booking_date
        ? '<table style="font-size:13px;background:#EEF1FA;border-radius:8px;padding:10px;margin:14px 0;width:100%;">'
          + (p.task_1     ? `<tr><td style="padding:4px 8px;color:#6B7A99">Tareas</td><td style="padding:4px 8px;font-weight:600">${p.task_1}${p.task_2 ? ' y ' + p.task_2 : ''}</td></tr>` : '')
          + (p.booking_date ? `<tr><td style="padding:4px 8px;color:#6B7A99">Fecha</td><td style="padding:4px 8px;font-weight:600">${p.booking_date}</td></tr>` : '')
          + (p.booking_time ? `<tr><td style="padding:4px 8px;color:#6B7A99">Hora</td><td style="padding:4px 8px;font-weight:600">${p.booking_time}</td></tr>` : '')
          + `<tr><td style="padding:4px 8px;color:#6B7A99">Total</td><td style="padding:4px 8px;font-weight:700">$${((p.total_amount || 17500) / 100).toFixed(0)}</td></tr>`
          + '</table>'
        : '') +
      `<p style="margin:18px 0;"><a href="${url}" style="display:inline-block;background:#3652A5;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">Terminar reservación →</a></p>` +
      `<p style="font-size:12px;color:#6B7A99;">¿Preguntas? (787) 419-0300 · info@domoyourhome.com</p>` +
      `<p style="font-size:11px;color:#6B7A99;margin-top:24px;">Si reservaste por otro canal o cambiaste de idea, ignora este correo.</p>` +
      '</div>',
  };
}

function buildOpsEmail(p) {
  const lines = [
    `Cliente: ${p.customer_name || '(sin nombre)'}`,
    `Tel:     ${p.customer_phone || '(sin teléfono)'}`,
    `Email:   ${p.customer_email}`,
    `Dirección: ${p.address || '(sin dirección)'}`,
    `Tareas:  ${p.task_1 || ''}${p.task_2 ? ' / ' + p.task_2 : ''}`,
    `Fecha:   ${p.booking_date || ''} ${p.booking_time || ''}`.trim(),
    `Pago:    ${p.payment_method || ''}`,
    `Total:   $${((p.total_amount || 17500) / 100).toFixed(2)}`,
    '',
    `Empezó: ${new Date(p.created_at).toLocaleString('es-PR')}`,
    `Última actualización: ${new Date(p.updated_at).toLocaleString('es-PR')}`,
  ];
  return {
    subject: `[Express] Reservación abandonada — ${p.customer_name || p.customer_email}`,
    text:
      `Una persona empezó a reservar Domo Express, llegó al paso de revisión, y no completó.\n\n` +
      lines.join('\n') +
      `\n\nLlámala/escríbele para ayudarla a terminar.\n— Sistema Domo`,
    html:
      '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#142543;max-width:520px;">' +
      `<h3>Reservación abandonada</h3>` +
      `<p>Una persona llegó al paso de revisión y no completó. Ayúdala a terminar:</p>` +
      `<table style="font-size:13px;border:1px solid #d4daf0;border-collapse:collapse;width:100%;">` +
      lines.filter(l => l).map(l => {
        const idx = l.indexOf(':');
        if (idx < 0) return `<tr><td colspan="2" style="padding:4px 8px;border-bottom:1px solid #eef1fa;">${l}</td></tr>`;
        const k = l.slice(0, idx).trim();
        const v = l.slice(idx + 1).trim();
        return `<tr><td style="padding:6px 10px;color:#6B7A99;border-bottom:1px solid #eef1fa;">${k}</td><td style="padding:6px 10px;font-weight:600;border-bottom:1px solid #eef1fa;">${v}</td></tr>`;
      }).join('') +
      `</table>` +
      (p.customer_phone ? `<p style="margin-top:14px;"><a href="tel:${String(p.customer_phone).replace(/\D/g, '')}" style="display:inline-block;background:#3652A5;color:#fff;text-decoration:none;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;">Llamar al cliente</a></p>` : '') +
      '</div>',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const provided = (event.headers || {})['x-cron-secret'] || (event.headers || {})['X-Cron-Secret'];
  if (!process.env.CRON_SECRET || provided !== process.env.CRON_SECRET) {
    return { statusCode: 401, body: 'unauthorized' };
  }
  if (!resend) {
    return { statusCode: 500, body: JSON.stringify({ error: 'resend_not_configured' }) };
  }

  const cutoffIso = new Date(Date.now() - ABANDON_AFTER_MS).toISOString();
  const { data: partials, error } = await supabase
    .from('express_partial_bookings')
    .select('*')
    .lte('updated_at', cutoffIso)
    .is('recovery_emailed_at', null);

  if (error) {
    console.error('recover-abandoned: fetch failed', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'db_error', detail: error.message }) };
  }

  const results = [];
  for (const p of (partials || [])) {
    // Skip if customer already completed a booking after this partial.
    const completed = await customerHasCompleted(p.customer_email, p.updated_at);
    if (completed) {
      await supabase
        .from('express_partial_bookings')
        .update({ recovery_emailed_at: new Date().toISOString(), ops_notified_at: new Date().toISOString() })
        .eq('id', p.id);
      results.push({ email: p.customer_email, skipped: 'completed' });
      continue;
    }

    let customerSent = false, opsSent = false;
    try {
      const cust = buildCustomerEmail(p);
      await resend.emails.send({
        from:    FROM,
        to:      [p.customer_email],
        subject: cust.subject,
        text:    cust.text,
        html:    cust.html,
      });
      customerSent = true;
    } catch (e) {
      console.error('recover-abandoned: customer email failed', p.customer_email, e.message);
    }

    try {
      const ops = buildOpsEmail(p);
      await resend.emails.send({
        from:    FROM,
        to:      ['janet@domoyourhome.com', 'info@domoyourhome.com'],
        subject: ops.subject,
        text:    ops.text,
        html:    ops.html,
      });
      opsSent = true;
    } catch (e) {
      console.error('recover-abandoned: ops email failed', p.customer_email, e.message);
    }

    await supabase
      .from('express_partial_bookings')
      .update({
        recovery_emailed_at: customerSent ? new Date().toISOString() : null,
        ops_notified_at:     opsSent      ? new Date().toISOString() : null,
      })
      .eq('id', p.id);

    results.push({ email: p.customer_email, customer_sent: customerSent, ops_sent: opsSent });
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scanned: (partials || []).length, results }),
  };
};
