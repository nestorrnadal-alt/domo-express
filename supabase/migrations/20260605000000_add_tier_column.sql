-- Adds a `tier` column to bookings + partial bookings so the table
-- can hold non-Express bookings (Básico / Completo / Proyecto) when
-- the in-flow per-tier UI ships. Defaults to 'express' so existing
-- rows backfill correctly and the existing book/track-partial code
-- continues to work without modification until the per-tier UI is
-- wired up.

alter table public.express_bookings
  add column if not exists tier text not null default 'express';

alter table public.express_partial_bookings
  add column if not exists tier text not null default 'express';

-- Check constraint enforces the closed set of allowed tiers. Add via
-- separate statement so the migration is idempotent across reruns.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'express_bookings_tier_check'
  ) then
    alter table public.express_bookings
      add constraint express_bookings_tier_check
      check (tier in ('express','basico','completo','proyecto'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'express_partial_bookings_tier_check'
  ) then
    alter table public.express_partial_bookings
      add constraint express_partial_bookings_tier_check
      check (tier in ('express','basico','completo','proyecto'));
  end if;
end$$;

-- Index for admin queries that filter by tier (eg. "show all Completo
-- bookings this week"). Cheap to maintain since tier cardinality is 4.
create index if not exists express_bookings_tier_idx
  on public.express_bookings (tier);
