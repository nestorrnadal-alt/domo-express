-- Allow Express bookings to capture up to 3 tasks instead of exactly
-- 2. task_2 and task_3 are now nullable so a customer can book with
-- 1, 2, or 3 tasks. Existing rows are unaffected (task_3 backfills
-- to NULL).

alter table public.express_bookings
  add column if not exists task_3 text;

alter table public.express_partial_bookings
  add column if not exists task_3 text;
