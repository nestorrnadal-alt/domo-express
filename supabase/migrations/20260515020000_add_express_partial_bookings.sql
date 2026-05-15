-- Captures customer state at the "review" step (step 5) so we can
-- re-engage if they don't complete the booking. Upserted on email
-- so a customer who abandons multiple times in a session ends up
-- with the latest snapshot.

create table if not exists public.express_partial_bookings (
  id                  bigserial primary key,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  customer_email      text not null,
  customer_phone      text,
  customer_name       text,
  address             text,
  task_1              text,
  task_2              text,
  booking_date        text,
  booking_date_iso    date,
  booking_time        text,
  payment_method      text,
  materials_requested boolean,
  materials_detail    text,
  total_amount        integer,
  recovery_emailed_at timestamptz,
  ops_notified_at     timestamptz
);

create unique index if not exists express_partials_email_unique
  on public.express_partial_bookings (lower(customer_email));

create index if not exists express_partials_due_recovery
  on public.express_partial_bookings (created_at)
  where recovery_emailed_at is null;

alter table public.express_partial_bookings enable row level security;
-- No policies — service-role functions only (anon/authenticated have no access).
