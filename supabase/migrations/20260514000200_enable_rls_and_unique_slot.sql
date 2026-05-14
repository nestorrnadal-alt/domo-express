-- Lock down anon / authenticated access on Express tables. The Netlify
-- functions use the service_role key, which bypasses RLS by default, so
-- no policies are needed for normal operation. Enabling RLS without
-- policies blocks every other role entirely — which is the goal here,
-- since nothing outside the function should touch these tables.

alter table public.express_bookings enable row level security;
alter table public.express_schedule_blackouts enable row level security;

-- Prevent two bookings landing on the same date + slot. Cancelled rows
-- are excluded so the slot frees up if a booking is cancelled. Rows
-- with null date/time (pre-migration data) are also excluded since the
-- ISO column is new.
create unique index if not exists express_bookings_unique_slot
  on public.express_bookings (booking_date_iso, booking_time)
  where status is distinct from 'cancelled'
    and booking_date_iso is not null
    and booking_time    is not null;
