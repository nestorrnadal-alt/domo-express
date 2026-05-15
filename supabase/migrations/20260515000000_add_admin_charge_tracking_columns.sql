-- Tracks Stripe charges initiated from the /admin view. Null until
-- Janet hits "Cobrar" on a booking after the service is done.

alter table public.express_bookings
  add column if not exists charged_at                timestamptz,
  add column if not exists charged_amount            integer,
  add column if not exists stripe_payment_intent_id  text;

comment on column public.express_bookings.charged_at is
  'When Janet charged the saved card from /admin. Null until charged.';
comment on column public.express_bookings.charged_amount is
  'Amount actually charged in cents — may differ from total_amount if extras were billed.';
comment on column public.express_bookings.stripe_payment_intent_id is
  'Stripe PaymentIntent id returned by the /api/admin/charge endpoint.';
