-- Manual schedule blackouts for Domo Express.
-- A row with blackout_slot = null disables the entire day; otherwise only
-- the matching time slot (e.g. '9:00 AM') is blocked. Availability is then
-- computed as: base business hours − blackouts − rows in express_bookings.

create table if not exists public.express_schedule_blackouts (
  id            uuid primary key default gen_random_uuid(),
  blackout_date date not null,
  blackout_slot text,
  reason        text,
  created_at    timestamptz not null default now()
);

create index if not exists express_schedule_blackouts_date_idx
  on public.express_schedule_blackouts (blackout_date);

-- booking_date is currently stored as a human label (e.g. "lunes, 15 de mayo")
-- which makes slot-availability checks fragile. Add an ISO date column the
-- frontend can populate alongside the label.
alter table public.express_bookings
  add column if not exists booking_date_iso date;

create index if not exists express_bookings_date_iso_time_idx
  on public.express_bookings (booking_date_iso, booking_time);
