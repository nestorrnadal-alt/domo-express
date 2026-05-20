// ============================================================
// GET /api/admin/metrics
//
// Aggregated performance metrics for the admin dashboard.
// Auth: same session cookie as other /api/admin/* endpoints.
//
// Returns JSON with:
//   range:              { from, to } — last 30 days
//   headline:           7-day vs prior-7-day deltas
//   funnel:             abandoned → confirmed → charged with rates
//   daily:              per-day series for the 30-day window
//   revenue:            month-to-date + prior month + average ticket
//   pipeline:           live counters by status / urgency
//   topTasks:           top 10 tasks by count
//   topSlots:           slot utilization
//   topDays:            day-of-week distribution
//
// All money values are in cents (integer).
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { requireSession } = require('./_admin-auth');
const ga4 = require('./_ga4');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const SITE_HOSTNAME = 'book.domoyourhome.com';

const PR_OFFSET_HOURS = -4;

function isoToday() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}
function shiftIso(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function slotStartUtcMs(iso, slot) {
  if (!iso || !slot) return 0;
  const [time, period] = String(slot).split(' ');
  if (!time || !period) return 0;
  let [h, m] = time.split(':').map(Number);
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  const [Y, M, D] = iso.split('-').map(Number);
  return Date.UTC(Y, M - 1, D, h - PR_OFFSET_HOURS, m || 0);
}

// Mirror of the bookingColor() bucket logic on the client so server +
// client report the same numbers.
function bookingBucket(b, nowMs) {
  if (b.charged_at) return 'charged';
  if (b.status === 'cancelled') return 'cancelled';
  if (b.status === 'completed' || b.status === 'no_show') return 'completed';
  const end = slotStartUtcMs(b.booking_date_iso, b.booking_time) + 2.5 * 3600 * 1000;
  if (end && end < nowMs) return 'completed';
  if (b.status === 'confirmed') return 'pending';
  return 'unassigned';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
  const unauthorized = requireSession(event);
  if (unauthorized) return unauthorized;

  const today      = isoToday();
  const from30     = shiftIso(today, -29);
  const from7      = shiftIso(today, -6);
  const fromPrior7 = shiftIso(today, -13);
  const monthStart = today.slice(0, 7) + '-01';
  const lastMonth  = shiftIso(monthStart, -1);
  const lastMonthStart = lastMonth.slice(0, 7) + '-01';
  const nowMs      = Date.now();

  // Pull everything in a tight set of queries.
  const [
    bookings30Result,
    bookingsPriorResult,
    bookingsThisMonthResult,
    bookingsLastMonthResult,
    bookingsUpcomingResult,
    partials30Result,
  ] = await Promise.all([
    supabase.from('express_bookings').select('*')
      .gte('booking_date_iso', from30).lte('booking_date_iso', today),
    supabase.from('express_bookings').select('*')
      .gte('booking_date_iso', fromPrior7).lte('booking_date_iso', shiftIso(today, -7)),
    supabase.from('express_bookings').select('*')
      .gte('booking_date_iso', monthStart).lte('booking_date_iso', today),
    supabase.from('express_bookings').select('*')
      .gte('booking_date_iso', lastMonthStart).lt('booking_date_iso', monthStart),
    supabase.from('express_bookings').select('*')
      .gte('booking_date_iso', today).lte('booking_date_iso', shiftIso(today, 7)),
    supabase.from('express_partial_bookings').select('id,created_at,recovery_emailed_at,customer_email')
      .gte('created_at', from30 + 'T00:00:00Z'),
  ]);

  const errs = [bookings30Result, bookingsPriorResult, bookingsThisMonthResult, bookingsLastMonthResult, bookingsUpcomingResult, partials30Result].find(r => r.error);
  if (errs) {
    console.error('admin-metrics: supabase error', errs.error);
    return { statusCode: 500, body: JSON.stringify({ error: 'db_error', detail: errs.error.message }) };
  }

  const bookings30      = bookings30Result.data       || [];
  const bookingsPrior   = bookingsPriorResult.data    || [];
  const bookingsMonth   = bookingsThisMonthResult.data|| [];
  const bookingsLastM   = bookingsLastMonthResult.data|| [];
  const upcoming        = bookingsUpcomingResult.data || [];
  const partials30      = partials30Result.data       || [];

  const last7 = bookings30.filter(b => b.booking_date_iso >= from7 && b.booking_date_iso <= today);

  // ---------- HEADLINE: 7d vs prior 7d ----------
  const count7      = last7.filter(b => b.status !== 'cancelled').length;
  const countPrior7 = bookingsPrior.filter(b => b.status !== 'cancelled').length;
  const revenue7    = last7.reduce((s, b) => s + (b.charged_amount || 0), 0);
  const revenuePrior7 = bookingsPrior.reduce((s, b) => s + (b.charged_amount || 0), 0);
  const cancel7     = last7.filter(b => b.status === 'cancelled').length;
  const cancelRate7 = last7.length > 0 ? cancel7 / last7.length : 0;
  const noShow7     = last7.filter(b => b.status === 'no_show').length;
  const noShowRate7 = last7.length > 0 ? noShow7 / last7.length : 0;

  // ---------- FUNNEL (30d) ----------
  // Sessions placeholder — GA4 fills this later.
  const partialCount30 = partials30.length;
  // Successful = bookings that were inserted (not cancelled = real customer commitments)
  const confirmedCount30 = bookings30.filter(b => b.status !== 'cancelled').length;
  const chargedCount30   = bookings30.filter(b => b.charged_at).length;

  // ---------- DAILY SERIES ----------
  const daysList = [];
  for (let i = 0; i < 30; i++) daysList.push(shiftIso(today, -29 + i));
  const dailyCount   = {};
  const dailyRevenue = {};
  daysList.forEach(d => { dailyCount[d] = 0; dailyRevenue[d] = 0; });
  bookings30.forEach(b => {
    if (b.status === 'cancelled') return;
    if (!b.booking_date_iso) return;
    if (dailyCount[b.booking_date_iso] === undefined) return;
    dailyCount[b.booking_date_iso]++;
    dailyRevenue[b.booking_date_iso] += (b.charged_amount || b.total_amount || 0);
  });
  const daily = daysList.map(d => ({ date: d, count: dailyCount[d], revenue: dailyRevenue[d] }));

  // ---------- REVENUE ----------
  const revenueMonth     = bookingsMonth.reduce((s, b) => s + (b.charged_amount || 0), 0);
  const revenueLastMonth = bookingsLastM.reduce((s, b) => s + (b.charged_amount || 0), 0);
  const completedThisMonth = bookingsMonth.filter(b => b.charged_at);
  const avgTicket = completedThisMonth.length > 0
    ? Math.round(completedThisMonth.reduce((s, b) => s + (b.charged_amount || 0), 0) / completedThisMonth.length)
    : 0;
  const pendingCharge = bookings30
    .filter(b => bookingBucket(b, nowMs) === 'completed') // ready to charge
    .reduce((s, b) => s + (b.total_amount || 0), 0);

  // ---------- PIPELINE ----------
  const tomorrowEnd = new Date(nowMs + 24 * 3600 * 1000);
  const next7End    = new Date(nowMs +  7 * 24 * 3600 * 1000);
  const pipeline = { next24h: 0, next7d: 0, unassigned: 0, readyToCharge: 0, rescheduled: 0, cancelled30: 0 };
  upcoming.forEach(b => {
    if (b.status === 'cancelled') return;
    const startMs = slotStartUtcMs(b.booking_date_iso, b.booking_time);
    if (startMs > nowMs && startMs <= tomorrowEnd.getTime()) pipeline.next24h++;
    if (startMs > nowMs && startMs <= next7End.getTime())    pipeline.next7d++;
  });
  bookings30.forEach(b => {
    const bucket = bookingBucket(b, nowMs);
    if (bucket === 'unassigned') pipeline.unassigned++;
    if (bucket === 'completed')  pipeline.readyToCharge++;
    if (b.status === 'cancelled') pipeline.cancelled30++;
  });
  // "Rescheduled" detection is approximate — we don't store a separate flag, so we count
  // bookings whose updated_at is much later than created_at and not cancelled.
  pipeline.rescheduled = bookings30.filter(b => {
    if (b.status === 'cancelled') return false;
    if (!b.updated_at || !b.created_at) return false;
    return (new Date(b.updated_at) - new Date(b.created_at)) > 6 * 3600 * 1000; // >6h apart
  }).length;

  // ---------- ABANDONED CART RECOVERY ----------
  const partialsThatRecovered = partials30.filter(p => {
    // Customer email later appeared in express_bookings created after the partial's created_at
    return bookings30.some(b =>
      (b.customer_email || '').toLowerCase() === (p.customer_email || '').toLowerCase()
      && b.created_at > p.created_at
    );
  }).length;
  const recoveryRate = partials30.length > 0 ? partialsThatRecovered / partials30.length : 0;

  // ---------- TOP TASKS ----------
  const taskCounts = {};
  bookings30.forEach(b => {
    if (b.status === 'cancelled') return;
    [b.task_1, b.task_2].forEach(t => { if (t) taskCounts[t] = (taskCounts[t] || 0) + 1; });
  });
  const topTasks = Object.entries(taskCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([task, count]) => ({ task, count }));

  // ---------- TOP SLOTS ----------
  const slotCounts = {};
  bookings30.forEach(b => {
    if (b.status === 'cancelled') return;
    if (b.booking_time) slotCounts[b.booking_time] = (slotCounts[b.booking_time] || 0) + 1;
  });
  const topSlots = Object.entries(slotCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([slot, count]) => ({ slot, count }));

  // ---------- TOP DAYS OF WEEK ----------
  const dowCounts = [0, 0, 0, 0, 0, 0, 0];
  bookings30.forEach(b => {
    if (b.status === 'cancelled' || !b.booking_date_iso) return;
    const [Y, M, D] = b.booking_date_iso.split('-').map(Number);
    const dow = new Date(Date.UTC(Y, M - 1, D)).getUTCDay();
    dowCounts[dow]++;
  });

  // ---------- GA4 sessions (last 30 days) ----------
  // Wrapped in try/catch so a Data API failure (missing creds, quota,
  // network) doesn't poison the rest of the dashboard. Frontend will
  // show "—" in the sessions cell if this comes back null.
  let sessions30  = null;
  let topSources  = null;
  if (ga4.isConfigured()) {
    try {
      const sessionsResp = await ga4.fetchHostnameMetrics({
        startDate: from30,
        endDate:   today,
        hostname:  SITE_HOSTNAME,
      });
      sessions30 = (sessionsResp.rows || []).reduce((s, r) => s + Number((r.metricValues || [])[0]?.value || 0), 0);
    } catch (e) {
      console.error('admin-metrics: GA4 sessions fetch failed', e.message);
    }
    try {
      const sourcesResp = await ga4.fetchSourceMetrics({
        startDate: from30,
        endDate:   today,
        hostname:  SITE_HOSTNAME,
      });
      topSources = (sourcesResp.rows || []).slice(0, 8).map(r => ({
        source:   (r.dimensionValues || [])[0]?.value || '(unknown)',
        sessions: Number((r.metricValues || [])[0]?.value || 0),
      }));
    } catch (e) {
      console.error('admin-metrics: GA4 sources fetch failed', e.message);
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      range: { from: from30, to: today },
      ga4_configured: ga4.isConfigured(),
      headline: {
        bookings:     { now: count7,      prior: countPrior7 },
        revenue:      { now: revenue7,    prior: revenuePrior7 },
        cancelRate:   { now: cancelRate7, count: cancel7 },
        noShowRate:   { now: noShowRate7, count: noShow7 },
      },
      funnel: {
        sessions:  sessions30,
        partials:  partialCount30,
        confirmed: confirmedCount30,
        charged:   chargedCount30,
      },
      topSources,
      daily,
      revenue: {
        thisMonth:     revenueMonth,
        lastMonth:     revenueLastMonth,
        avgTicket:     avgTicket,
        pendingCharge: pendingCharge,
      },
      pipeline,
      recovery: {
        total:     partials30.length,
        recovered: partialsThatRecovered,
        rate:      recoveryRate,
      },
      topTasks,
      topSlots,
      topDays: ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'].map((label, i) => ({ label, count: dowCounts[i] })),
    }),
  };
};
