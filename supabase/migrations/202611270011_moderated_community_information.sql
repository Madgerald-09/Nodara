-- Official, moderated community information. This migration depends on the
-- privacy/report foundations in 010 and does not reference migration 008.

create table if not exists public.community_public_info (
  community_id uuid primary key references public.communities(id) on delete cascade,
  official_website text check (official_website is null or char_length(official_website) <= 2048),
  official_links jsonb not null default '[]'::jsonb
    check (jsonb_typeof(official_links) = 'array' and jsonb_array_length(official_links) <= 10 and octet_length(official_links::text) <= 8192),
  guidelines text check (guidelines is null or char_length(guidelines) <= 10000),
  updated_at timestamptz not null default now()
);

create table if not exists public.community_announcements (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete restrict,
  title text not null check (char_length(btrim(title)) between 3 and 180),
  body text not null check (char_length(btrim(body)) between 1 and 8000),
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'published', 'archived')),
  scheduled_for timestamptz,
  published_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint community_announcement_schedule_state check (
    (status = 'scheduled' and scheduled_for is not null and published_at is null and archived_at is null)
    or (status = 'published' and scheduled_for is null and published_at is not null and archived_at is null)
    or (status = 'archived' and archived_at is not null and scheduled_for is null)
    or (status = 'draft' and scheduled_for is null and published_at is null and archived_at is null)
  )
);
create index if not exists community_announcements_public_idx on public.community_announcements(community_id, published_at desc)
  where status = 'published';
create index if not exists community_announcements_due_idx on public.community_announcements(scheduled_for)
  where status = 'scheduled';
create index if not exists community_announcements_manager_idx on public.community_announcements(community_id, status, updated_at desc);

create table if not exists public.community_announcement_history (
  id uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.community_announcements(id) on delete cascade,
  community_id uuid not null references public.communities(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('created', 'edited', 'published', 'scheduled', 'archived', 'auto_published')),
  title_snapshot text not null,
  body_snapshot text not null,
  status_snapshot text not null check (status_snapshot in ('draft', 'scheduled', 'published', 'archived')),
  created_at timestamptz not null default now()
);
create index if not exists community_announcement_history_lookup_idx on public.community_announcement_history(announcement_id, created_at desc);
create index if not exists community_announcement_history_community_idx on public.community_announcement_history(community_id, created_at desc);

create table if not exists public.community_event_highlights (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  added_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint community_event_highlights_unique unique (community_id, event_id)
);
create index if not exists community_event_highlights_community_idx on public.community_event_highlights(community_id, created_at desc);
create index if not exists community_event_highlights_event_idx on public.community_event_highlights(event_id);

alter table public.community_public_info enable row level security;
alter table public.community_announcements enable row level security;
alter table public.community_announcement_history enable row level security;
alter table public.community_event_highlights enable row level security;

revoke all on public.community_public_info, public.community_announcements, public.community_announcement_history, public.community_event_highlights from public, anon, authenticated;
grant all on public.community_public_info, public.community_announcements, public.community_announcement_history, public.community_event_highlights to service_role;
grant select on public.community_public_info to anon, authenticated;
grant select (id, community_id, title, body, status, scheduled_for, published_at, archived_at, created_at, updated_at)
  on public.community_announcements to anon, authenticated;
grant select (id, announcement_id, community_id, action, title_snapshot, body_snapshot, status_snapshot, created_at)
  on public.community_announcement_history to authenticated;
grant select (community_id, event_id, created_at) on public.community_event_highlights to anon, authenticated;

create function public.can_manage_community(p_community_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.communities c
    where c.id = p_community_id and (
      c.creator_id = auth.uid() or exists (
        select 1 from public.community_members cm
        where cm.community_id = c.id and cm.user_id = auth.uid() and cm.role in ('owner', 'moderator')
      )
    )
  );
$$;
revoke all on function public.can_manage_community(uuid) from public, anon;
grant execute on function public.can_manage_community(uuid) to anon, authenticated;

create policy community_public_info_read on public.community_public_info
  for select to anon, authenticated using (true);
create policy community_announcements_read_published_or_managed on public.community_announcements
  for select to anon, authenticated using (
    (status = 'published' and published_at <= now()) or (select public.can_manage_community(community_id))
  );
create policy community_announcement_history_read_managers on public.community_announcement_history
  for select to authenticated using ((select public.can_manage_community(community_id)));
create policy community_highlights_read_upcoming_published on public.community_event_highlights
  for select to anon, authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.status = 'published' and e.start_date > now())
    or (select public.can_manage_community(community_id))
  );

create function public.save_community_public_info(p_community_id uuid, p_website text, p_links jsonb, p_guidelines text)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_link jsonb; v_url text; v_website text; v_guidelines text; v_updated timestamptz;
begin
  if auth.uid() is null or not public.can_manage_community(p_community_id) then raise exception 'Community manager access required'; end if;
  v_website := nullif(btrim(p_website), '');
  v_guidelines := nullif(btrim(p_guidelines), '');
  if v_website is not null and (char_length(v_website) > 2048 or v_website !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]*)?$') then
    raise exception 'Official website must be a valid HTTPS URL';
  end if;
  if v_guidelines is not null and char_length(v_guidelines) > 10000 then raise exception 'Guidelines are too long'; end if;
  if p_links is null or jsonb_typeof(p_links) <> 'array' then raise exception 'Official links must be an array of HTTPS URLs'; end if;
  if jsonb_array_length(p_links) > 10 then raise exception 'Provide at most 10 official HTTPS links'; end if;
  for v_link in select value from jsonb_array_elements(p_links) loop
    if jsonb_typeof(v_link) <> 'string' then raise exception 'Official links must be HTTPS URL strings'; end if;
    v_url := btrim(v_link #>> '{}');
    if char_length(v_url) > 2048 or v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]*)?$' then
      raise exception 'Official links must be valid HTTPS URLs';
    end if;
  end loop;
  insert into public.community_public_info(community_id, official_website, official_links, guidelines, updated_at)
  values (p_community_id, v_website, p_links, v_guidelines, now())
  on conflict (community_id) do update set official_website = excluded.official_website,
    official_links = excluded.official_links, guidelines = excluded.guidelines, updated_at = now()
  returning updated_at into v_updated;
  return v_updated;
end;
$$;
revoke all on function public.save_community_public_info(uuid, text, jsonb, text) from public, anon;
grant execute on function public.save_community_public_info(uuid, text, jsonb, text) to authenticated;

create function public.create_community_announcement(p_community_id uuid, p_title text, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_announcement public.community_announcements%rowtype;
begin
  if auth.uid() is null or not public.can_manage_community(p_community_id) then raise exception 'Community manager access required'; end if;
  if char_length(btrim(p_title)) not between 3 and 180 or char_length(btrim(p_body)) not between 1 and 8000 then raise exception 'Announcement title or body is invalid'; end if;
  insert into public.community_announcements(community_id, author_id, title, body)
  values (p_community_id, auth.uid(), btrim(p_title), btrim(p_body)) returning * into v_announcement;
  insert into public.community_announcement_history(announcement_id, community_id, actor_id, action, title_snapshot, body_snapshot, status_snapshot)
  values (v_announcement.id, p_community_id, auth.uid(), 'created', v_announcement.title, v_announcement.body, v_announcement.status);
  return v_announcement.id;
end;
$$;
revoke all on function public.create_community_announcement(uuid, text, text) from public, anon;
grant execute on function public.create_community_announcement(uuid, text, text) to authenticated;

create function public.edit_community_announcement(p_announcement_id uuid, p_title text, p_body text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_announcement public.community_announcements%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_announcement from public.community_announcements where id = p_announcement_id for update;
  if not found or not public.can_manage_community(v_announcement.community_id) then raise exception 'Announcement not found or manager access denied'; end if;
  if v_announcement.status = 'archived' then raise exception 'Archived announcements cannot be edited'; end if;
  if char_length(btrim(p_title)) not between 3 and 180 or char_length(btrim(p_body)) not between 1 and 8000 then raise exception 'Announcement title or body is invalid'; end if;
  insert into public.community_announcement_history(announcement_id, community_id, actor_id, action, title_snapshot, body_snapshot, status_snapshot)
  values (v_announcement.id, v_announcement.community_id, auth.uid(), 'edited', v_announcement.title, v_announcement.body, v_announcement.status);
  update public.community_announcements set title = btrim(p_title), body = btrim(p_body), updated_at = now()
  where id = v_announcement.id;
end;
$$;
revoke all on function public.edit_community_announcement(uuid, text, text) from public, anon;
grant execute on function public.edit_community_announcement(uuid, text, text) to authenticated;

create function public.publish_community_announcement(p_announcement_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_announcement public.community_announcements%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_announcement from public.community_announcements where id = p_announcement_id for update;
  if not found or not public.can_manage_community(v_announcement.community_id) then raise exception 'Announcement not found or manager access denied'; end if;
  if v_announcement.status not in ('draft', 'scheduled') then raise exception 'Only draft or scheduled announcements can be published'; end if;
  insert into public.community_announcement_history(announcement_id, community_id, actor_id, action, title_snapshot, body_snapshot, status_snapshot)
  values (v_announcement.id, v_announcement.community_id, auth.uid(), 'published', v_announcement.title, v_announcement.body, v_announcement.status);
  update public.community_announcements set status = 'published', scheduled_for = null, published_at = now(), updated_at = now(), archived_at = null
  where id = v_announcement.id;
end;
$$;
revoke all on function public.publish_community_announcement(uuid) from public, anon;
grant execute on function public.publish_community_announcement(uuid) to authenticated;

create function public.schedule_community_announcement(p_announcement_id uuid, p_scheduled_for timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare v_announcement public.community_announcements%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_scheduled_for is null or p_scheduled_for <= now() then raise exception 'Choose a future publication time'; end if;
  select * into v_announcement from public.community_announcements where id = p_announcement_id for update;
  if not found or not public.can_manage_community(v_announcement.community_id) then raise exception 'Announcement not found or manager access denied'; end if;
  if v_announcement.status not in ('draft', 'scheduled') then raise exception 'Only draft or scheduled announcements can be scheduled'; end if;
  insert into public.community_announcement_history(announcement_id, community_id, actor_id, action, title_snapshot, body_snapshot, status_snapshot)
  values (v_announcement.id, v_announcement.community_id, auth.uid(), 'scheduled', v_announcement.title, v_announcement.body, 'scheduled');
  update public.community_announcements set status = 'scheduled', scheduled_for = p_scheduled_for, published_at = null, updated_at = now(), archived_at = null
  where id = v_announcement.id;
end;
$$;
revoke all on function public.schedule_community_announcement(uuid, timestamptz) from public, anon;
grant execute on function public.schedule_community_announcement(uuid, timestamptz) to authenticated;

create function public.archive_community_announcement(p_announcement_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_announcement public.community_announcements%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_announcement from public.community_announcements where id = p_announcement_id for update;
  if not found or not public.can_manage_community(v_announcement.community_id) then raise exception 'Announcement not found or manager access denied'; end if;
  if v_announcement.status = 'archived' then return; end if;
  insert into public.community_announcement_history(announcement_id, community_id, actor_id, action, title_snapshot, body_snapshot, status_snapshot)
  values (v_announcement.id, v_announcement.community_id, auth.uid(), 'archived', v_announcement.title, v_announcement.body, v_announcement.status);
  update public.community_announcements set status = 'archived', scheduled_for = null, archived_at = now(), updated_at = now()
  where id = v_announcement.id;
end;
$$;
revoke all on function public.archive_community_announcement(uuid) from public, anon;
grant execute on function public.archive_community_announcement(uuid) to authenticated;

create function public.set_community_event_highlight(p_community_id uuid, p_event_id uuid, p_featured boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.can_manage_community(p_community_id) then raise exception 'Community manager access required'; end if;
  if p_featured then
    if not exists (select 1 from public.events e where e.id = p_event_id and e.status = 'published' and e.start_date > now()) then
      raise exception 'Only published upcoming events can be highlighted';
    end if;
    insert into public.community_event_highlights(community_id, event_id, added_by) values (p_community_id, p_event_id, auth.uid())
      on conflict (community_id, event_id) do nothing;
  else
    delete from public.community_event_highlights where community_id = p_community_id and event_id = p_event_id;
  end if;
end;
$$;
revoke all on function public.set_community_event_highlight(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_community_event_highlight(uuid, uuid, boolean) to authenticated;

create function public.publish_due_community_announcements()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_announcement public.community_announcements%rowtype; v_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  for v_announcement in
    select * from public.community_announcements
    where status = 'scheduled' and scheduled_for <= now()
    order by scheduled_for asc
    for update skip locked
  loop
    insert into public.community_announcement_history(announcement_id, community_id, actor_id, action, title_snapshot, body_snapshot, status_snapshot)
    values (v_announcement.id, v_announcement.community_id, null, 'auto_published', v_announcement.title, v_announcement.body, v_announcement.status);
    update public.community_announcements set status = 'published', published_at = v_announcement.scheduled_for,
      scheduled_for = null, updated_at = now() where id = v_announcement.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.publish_due_community_announcements() from public, anon, authenticated;
grant execute on function public.publish_due_community_announcements() to service_role;

-- Add announcement reports to the existing private report table, retaining its
-- existing event/community rows and indexes. Announcement targets are validated
-- by the submission RPC and their community_id is recorded for audit routing.
alter table public.platform_reports add column if not exists community_id uuid references public.communities(id) on delete set null;
alter table public.platform_reports drop constraint if exists platform_reports_target_type_check;
alter table public.platform_reports add constraint platform_reports_target_type_check
  check (target_type in ('event', 'community', 'announcement'));
create index if not exists platform_reports_community_created_idx on public.platform_reports(community_id, created_at desc);

create or replace function public.submit_platform_report(p_target_type text, p_target_id uuid, p_reason text, p_description text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_description text; v_community_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_target_id is null or p_target_type is null or p_target_type not in ('event', 'community', 'announcement') then raise exception 'Unsupported report target'; end if;
  if p_reason not in ('misleading_information', 'incorrect_details', 'inappropriate_content', 'impersonation', 'other') then raise exception 'Unsupported report reason'; end if;
  v_description := nullif(btrim(p_description), '');
  if v_description is not null and char_length(v_description) > 1000 then raise exception 'Report explanation is too long'; end if;
  perform 1 from auth.users u where u.id = auth.uid() for update;
  if (select count(*) from public.platform_reports r where r.reporter_id = auth.uid() and r.created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Report limit reached. Please try again later';
  end if;
  if p_target_type = 'event' then
    if not exists (select 1 from public.events e where e.id = p_target_id and e.status = 'published') then raise exception 'Event is not available for reporting'; end if;
  elsif p_target_type = 'community' then
    if not exists (select 1 from public.communities c where c.id = p_target_id) then raise exception 'Community is not available for reporting'; end if;
  else
    select a.community_id into v_community_id from public.community_announcements a
    where a.id = p_target_id and a.status = 'published' and a.published_at <= now();
    if v_community_id is null then raise exception 'Announcement is not available for reporting'; end if;
  end if;
  insert into public.platform_reports(reporter_id, target_type, target_id, community_id, reason, description)
  values (auth.uid(), p_target_type, p_target_id, v_community_id, p_reason, v_description)
  returning id into v_id;
  return v_id;
exception when unique_violation then raise exception 'You already have an open report for this item';
end;
$$;
revoke all on function public.submit_platform_report(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.submit_platform_report(text, uuid, text, text) to authenticated;

comment on table public.community_public_info is 'Public community information is read-only to clients; owner/moderator changes use a permission-checked RPC.';
comment on table public.community_announcements is 'Official notices only; drafts and scheduled items are visible only to community managers.';
comment on function public.publish_due_community_announcements() is 'Service-role-only worker RPC. Configure an external Supabase Cron schedule to invoke it; scheduled notices stay private until this executes.';
