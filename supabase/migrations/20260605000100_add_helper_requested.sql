-- Persists the customer's "needs a helper" opt-in. When true, the
-- handyman brings a second person to the visit and the booking total
-- includes a $200 (+IVU) helper fee.

alter table public.express_bookings
  add column if not exists helper_requested boolean not null default false;

alter table public.express_partial_bookings
  add column if not exists helper_requested boolean not null default false;
