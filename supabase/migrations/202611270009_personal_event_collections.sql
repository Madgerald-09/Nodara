-- Private collections organize events already saved by the authenticated owner.
-- This migration is additive and does not change saved_events semantics.
create table public.event_collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_collections_unique_name_per_user unique(user_id, name)
);
create index event_collections_user_created_idx on public.event_collections(user_id, created_at desc);

create table public.event_collection_items (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.event_collections(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint event_collection_items_unique unique(collection_id, event_id)
);
create index event_collection_items_event_idx on public.event_collection_items(event_id, collection_id);

alter table public.event_collections enable row level security;
alter table public.event_collection_items enable row level security;

revoke all on table public.event_collections, public.event_collection_items from public, anon, authenticated;
grant all on table public.event_collections, public.event_collection_items to service_role;

grant select, delete on public.event_collections to authenticated;
grant insert (user_id, name) on public.event_collections to authenticated;
grant update (name) on public.event_collections to authenticated;
grant select, delete on public.event_collection_items to authenticated;
grant insert (collection_id, event_id) on public.event_collection_items to authenticated;

create policy "Users read their own event collections" on public.event_collections
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Users create their own event collections" on public.event_collections
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users rename their own event collections" on public.event_collections
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "Users delete their own event collections" on public.event_collections
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "Users read items in their own event collections" on public.event_collection_items
  for select to authenticated using (exists (
    select 1 from public.event_collections c
    where c.id = collection_id and c.user_id = (select auth.uid())
  ));
create policy "Users add saved events to their own collections" on public.event_collection_items
  for insert to authenticated with check (
    exists (select 1 from public.event_collections c
      where c.id = public.event_collection_items.collection_id and c.user_id = (select auth.uid()))
    and exists (select 1 from public.saved_events s
      where s.user_id = (select auth.uid()) and s.event_id = public.event_collection_items.event_id)
  );
create policy "Users remove items from their own event collections" on public.event_collection_items
  for delete to authenticated using (exists (
    select 1 from public.event_collections c
    where c.id = collection_id and c.user_id = (select auth.uid())
  ));

create trigger event_collections_updated_at before update on public.event_collections
for each row execute function public.set_updated_at();

create function public.remove_unsaved_event_from_collections()
returns trigger language plpgsql set search_path = '' as $$
begin
  delete from public.event_collection_items i
  using public.event_collections c
  where i.collection_id = c.id and c.user_id = old.user_id and i.event_id = old.event_id;
  return old;
end;
$$;
revoke all on function public.remove_unsaved_event_from_collections() from public, anon, authenticated;
create trigger saved_event_removed_from_collections after delete on public.saved_events
for each row execute function public.remove_unsaved_event_from_collections();
