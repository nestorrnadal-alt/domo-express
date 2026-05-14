-- Add Stripe customer + payment_method references to express_bookings.
-- Applied at booking time when payment_method = 'credit_card'. Domo
-- charges the saved payment method off-session after the service.

alter table public.express_bookings
  add column if not exists stripe_customer_id       text,
  add column if not exists stripe_payment_method_id text;

create index if not exists express_bookings_stripe_customer_id_idx
  on public.express_bookings (stripe_customer_id);
