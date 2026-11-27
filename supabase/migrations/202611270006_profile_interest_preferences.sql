-- Category interests are user-owned profile preferences. The existing profile
-- RLS policy continues to limit writes to the authenticated user's own row.
alter table public.profiles
  add column if not exists interest_categories text[] not null default '{}'::text[];

alter table public.profiles
  add constraint profiles_interest_categories_valid check (
    cardinality(interest_categories) <= 9
    and array_position(interest_categories, null) is null
    and interest_categories <@ array[
      'Technology', 'Music', 'Business', 'Art & Culture', 'Sports',
      'Gaming', 'Education', 'Adventure', 'Social'
    ]::text[]
  );

-- Table-level UPDATE remains revoked; this grants only the new preference field.
grant update (interest_categories) on public.profiles to authenticated;
