create extension if not exists pgcrypto with schema extensions;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text check (full_name is null or char_length(full_name) <= 120),
  username text unique check (username is null or username ~ '^[a-z0-9_]{3,30}$'),
  avatar_url text,
  bio text check (bio is null or char_length(bio) <= 500),
  location text check (location is null or char_length(location) <= 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references public.profiles(id) on delete restrict,
  title text not null check (char_length(title) between 3 and 180),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text not null check (char_length(description) between 1 and 10000),
  category text not null check (char_length(category) between 1 and 60),
  cover_image text,
  location text not null check (char_length(location) between 1 and 180),
  venue text,
  country text not null check (char_length(country) between 1 and 100),
  start_date timestamptz not null,
  end_date timestamptz,
  price numeric(12,2) not null default 0 check (price >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  capacity integer check (capacity is null or capacity > 0),
  status text not null default 'draft' check (status in ('draft', 'published', 'cancelled', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint events_end_after_start check (end_date is null or end_date >= start_date)
);

create table public.communities (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete restrict,
  name text not null check (char_length(name) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text not null check (char_length(description) between 1 and 2000),
  category text not null check (char_length(category) between 1 and 60),
  cover_image text,
  location text,
  created_at timestamptz not null default now()
);

create table public.community_members (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('member', 'moderator', 'owner')),
  joined_at timestamptz not null default now(),
  constraint community_members_unique_membership unique (community_id, user_id)
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete restrict,
  quantity integer not null check (quantity between 1 and 20),
  total_amount numeric(12,2) not null check (total_amount >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled')),
  created_at timestamptz not null default now()
);

create table public.saved_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint saved_events_unique_save unique (event_id, user_id)
);

create index events_published_start_date_idx on public.events (start_date) where status = 'published';
create index events_category_published_idx on public.events (category, start_date) where status = 'published';
create index events_location_published_idx on public.events (location, start_date) where status = 'published';
create index events_organizer_idx on public.events (organizer_id, created_at desc);
create index communities_category_idx on public.communities (category, created_at desc);
create index community_members_user_idx on public.community_members (user_id, community_id);
create index bookings_user_idx on public.bookings (user_id, created_at desc);
create index bookings_event_idx on public.bookings (event_id, status);
create index saved_events_user_idx on public.saved_events (user_id, created_at desc);

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger events_set_updated_at before update on public.events
for each row execute function public.set_updated_at();

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(left(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 120), ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.handle_new_user() to service_role;

create function public.add_community_creator_as_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.community_members (community_id, user_id, role)
  values (new.id, new.creator_id, 'owner');
  return new;
end;
$$;

create trigger community_creator_membership after insert on public.communities
for each row execute function public.add_community_creator_as_owner();

revoke execute on function public.add_community_creator_as_owner() from public, anon, authenticated;
grant execute on function public.add_community_creator_as_owner() to service_role;

create function public.prepare_booking()
returns trigger
language plpgsql
set search_path = ''
as $$
declare event_price numeric(12,2); event_currency text; event_status text;
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.event_id is distinct from old.event_id
      or new.user_id is distinct from old.user_id or new.quantity is distinct from old.quantity
      or new.total_amount is distinct from old.total_amount or new.currency is distinct from old.currency
      or new.created_at is distinct from old.created_at
      or old.status <> 'pending' or new.status <> 'cancelled' then
      raise exception 'Bookings can only be cancelled while pending';
    end if;
    return new;
  end if;
  select price, currency, status into event_price, event_currency, event_status
  from public.events where id = new.event_id;
  if event_status is distinct from 'published' then
    raise exception 'Bookings can only be requested for published events';
  end if;
  new.total_amount := event_price * new.quantity;
  new.currency := event_currency;
  new.status := 'pending';
  new.created_at := now();
  return new;
end;
$$;

create trigger bookings_validate before insert or update on public.bookings
for each row execute function public.prepare_booking();

create function public.get_community_member_counts()
returns table (community_id uuid, member_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select cm.community_id, count(*)::bigint
  from public.community_members as cm
  group by cm.community_id;
$$;

revoke all on function public.get_community_member_counts() from public;
grant execute on function public.get_community_member_counts() to anon, authenticated;
grant execute on function public.get_community_member_counts() to service_role;

alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.communities enable row level security;
alter table public.community_members enable row level security;
alter table public.bookings enable row level security;
alter table public.saved_events enable row level security;

create policy "Users read own profile" on public.profiles for select to authenticated
using (id = (select auth.uid()));
create policy "Users update own profile" on public.profiles for update to authenticated
using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "Published events and own events are readable" on public.events for select to anon, authenticated
using (status = 'published' or organizer_id = (select auth.uid()));
create policy "Organisers create their own events" on public.events for insert to authenticated
with check (organizer_id = (select auth.uid()));
create policy "Organisers update their own events" on public.events for update to authenticated
using (organizer_id = (select auth.uid())) with check (organizer_id = (select auth.uid()));
create policy "Organisers delete their own events" on public.events for delete to authenticated
using (organizer_id = (select auth.uid()));

create policy "Communities are publicly readable" on public.communities for select to anon, authenticated
using (true);
create policy "Authenticated users create communities as themselves" on public.communities for insert to authenticated
with check (creator_id = (select auth.uid()));
create policy "Creators update their own communities" on public.communities for update to authenticated
using (creator_id = (select auth.uid())) with check (creator_id = (select auth.uid()));
create policy "Creators delete their own communities" on public.communities for delete to authenticated
using (creator_id = (select auth.uid()));

create policy "Users read their own memberships" on public.community_members for select to authenticated
using (user_id = (select auth.uid()));
create policy "Users join as regular members" on public.community_members for insert to authenticated
with check (user_id = (select auth.uid()) and role = 'member');
create policy "Members can leave without changing ownership" on public.community_members for delete to authenticated
using (user_id = (select auth.uid()) and role in ('member', 'moderator'));

create policy "Users read own bookings" on public.bookings for select to authenticated
using (user_id = (select auth.uid()));
create policy "Users create pending booking requests" on public.bookings for insert to authenticated
with check (user_id = (select auth.uid()) and status = 'pending');
create policy "Users cancel own pending booking requests" on public.bookings for update to authenticated
using (user_id = (select auth.uid()) and status = 'pending')
with check (user_id = (select auth.uid()) and status = 'cancelled');

create policy "Users read own saved events" on public.saved_events for select to authenticated
using (user_id = (select auth.uid()));
create policy "Users save events for themselves" on public.saved_events for insert to authenticated
with check (user_id = (select auth.uid()));
create policy "Users remove their own saved events" on public.saved_events for delete to authenticated
using (user_id = (select auth.uid()));

revoke all privileges on table
  public.profiles,
  public.events,
  public.communities,
  public.community_members,
  public.bookings,
  public.saved_events
from public, anon, authenticated;

grant all privileges on table
  public.profiles,
  public.events,
  public.communities,
  public.community_members,
  public.bookings,
  public.saved_events
to service_role;

grant select on public.events to anon, authenticated;
grant insert, update, delete on public.events to authenticated;
grant select on public.communities to anon, authenticated;
grant insert, update, delete on public.communities to authenticated;
grant select, delete on public.community_members to authenticated;
grant insert (community_id, user_id, role) on public.community_members to authenticated;
grant select on public.bookings to authenticated;
grant insert (event_id, user_id, quantity, total_amount, currency, status) on public.bookings to authenticated;
grant update (status) on public.bookings to authenticated;
grant select, delete on public.saved_events to authenticated;
grant insert (event_id, user_id) on public.saved_events to authenticated;
grant select on public.profiles to authenticated;
grant update (full_name, username, avatar_url, bio, location) on public.profiles to authenticated;
