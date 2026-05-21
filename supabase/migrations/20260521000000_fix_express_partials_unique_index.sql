-- Replace the function-based unique index (lower(customer_email))
-- with a plain unique index on customer_email so Supabase upsert
-- onConflict='customer_email' works. The application normalizes the
-- email to lowercase before writing, so case-insensitivity is still
-- preserved at the data layer.

drop index if exists public.express_partials_email_unique;

create unique index if not exists express_partials_email_unique
  on public.express_partial_bookings (customer_email);
