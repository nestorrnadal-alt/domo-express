-- Track when each booking's 24h-before WhatsApp reminder was sent
-- (via respond.io). Null until sent. Partial index speeds up the
-- cron job's "find due reminders" query.

alter table public.express_bookings
  add column if not exists reminder_sent_at timestamptz;

comment on column public.express_bookings.reminder_sent_at is
  'When the 24h-before WhatsApp reminder was sent via respond.io. Null = not yet sent. Used by the send-reminders cron to avoid double-firing.';

create index if not exists express_bookings_reminder_due_idx
  on public.express_bookings (booking_date_iso, booking_time)
  where reminder_sent_at is null
    and (status is null or status not in ('cancelled'));
