-- Private account safety workflows. This migration deliberately does not depend
-- on or modify the paused 202611270008_social_ecosystem migration.

create table if not exists public.platform_moderators (
  user_id uuid primary key references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create table if not exists public.platform_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete restrict,
  target_type text not null check (target_type in ('event', 'community')),
  target_id uuid not null,
  reason text not null check (reason in ('misleading_information', 'incorrect_details', 'inappropriate_content', 'impersonation', 'other')),
  description text check (description is null or char_length(description) <= 1000),
  status text not null default 'submitted' check (status in ('submitted', 'under_review', 'action_taken', 'dismissed', 'resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists platform_reports_reporter_created_idx on public.platform_reports(reporter_id, created_at desc);
create index if not exists platform_reports_queue_idx on public.platform_reports(status, created_at asc);
create unique index if not exists platform_reports_one_open_per_target_idx
  on public.platform_reports(reporter_id, target_type, target_id)
  where status in ('submitted', 'under_review');

create table if not exists public.platform_report_actions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.platform_reports(id) on delete restrict,
  moderator_id uuid not null references auth.users(id) on delete restrict,
  previous_status text not null check (previous_status in ('submitted', 'under_review', 'action_taken', 'dismissed', 'resolved')),
  new_status text not null check (new_status in ('under_review', 'action_taken', 'dismissed', 'resolved')),
  decision text not null check (char_length(btrim(decision)) between 1 and 1000),
  internal_note text check (internal_note is null or char_length(internal_note) <= 2000),
  created_at timestamptz not null default now()
);
create index if not exists platform_report_actions_report_idx on public.platform_report_actions(report_id, created_at desc);

create table if not exists public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'cancelled', 'approved', 'processing', 'completed', 'rejected')),
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz,
  completed_at timestamptz,
  constraint account_deletion_cancel_time_check check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint account_deletion_complete_time_check check ((status = 'completed') = (completed_at is not null))
);
create index if not exists account_deletion_user_requested_idx on public.account_deletion_requests(user_id, requested_at desc);
create unique index if not exists account_deletion_one_active_request_idx on public.account_deletion_requests(user_id)
  where status in ('pending', 'approved', 'processing');

alter table public.platform_moderators enable row level security;
alter table public.platform_reports enable row level security;
alter table public.platform_report_actions enable row level security;
alter table public.account_deletion_requests enable row level security;

revoke all on public.platform_moderators, public.platform_reports, public.platform_report_actions, public.account_deletion_requests from public, anon, authenticated;
grant all on public.platform_moderators, public.platform_reports, public.platform_report_actions, public.account_deletion_requests to service_role;
grant select on public.platform_reports, public.platform_report_actions, public.account_deletion_requests to authenticated;

create function public.is_platform_moderator()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.platform_moderators m where m.user_id = auth.uid()
  );
$$;
revoke all on function public.is_platform_moderator() from public, anon;
grant execute on function public.is_platform_moderator() to authenticated;

create policy platform_reports_read_reporter_or_moderator on public.platform_reports
  for select to authenticated using (reporter_id = (select auth.uid()) or (select public.is_platform_moderator()));
create policy platform_report_actions_read_moderator on public.platform_report_actions
  for select to authenticated using ((select public.is_platform_moderator()));
create policy account_deletion_requests_read_owner on public.account_deletion_requests
  for select to authenticated using (user_id = (select auth.uid()));

create function public.submit_platform_report(p_target_type text, p_target_id uuid, p_reason text, p_description text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_description text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_target_id is null or p_target_type is null or p_target_type not in ('event', 'community') then raise exception 'Unsupported report target'; end if;
  if p_reason not in ('misleading_information', 'incorrect_details', 'inappropriate_content', 'impersonation', 'other') then raise exception 'Unsupported report reason'; end if;
  v_description := nullif(btrim(p_description), '');
  if v_description is not null and char_length(v_description) > 1000 then raise exception 'Report explanation is too long'; end if;
  -- Serialize report submissions by this account to keep the rolling cap race-safe.
  perform 1 from auth.users u where u.id = auth.uid() for update;
  if (select count(*) from public.platform_reports r where r.reporter_id = auth.uid()
      and r.created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Report limit reached. Please try again later';
  end if;
  if p_target_type = 'event' and not exists (select 1 from public.events e where e.id = p_target_id and e.status = 'published') then
    raise exception 'Event is not available for reporting';
  elsif p_target_type = 'community' and not exists (select 1 from public.communities c where c.id = p_target_id) then
    raise exception 'Community is not available for reporting';
  end if;
  insert into public.platform_reports(reporter_id, target_type, target_id, reason, description)
  values (auth.uid(), p_target_type, p_target_id, p_reason, v_description)
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'You already have an open report for this item';
end;
$$;
revoke all on function public.submit_platform_report(text, uuid, text, text) from public, anon;
grant execute on function public.submit_platform_report(text, uuid, text, text) to authenticated;

create function public.request_account_deletion(p_confirmation text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_auth_time bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  v_auth_time := nullif(auth.jwt()->>'auth_time', '')::bigint;
  if v_auth_time is null or to_timestamp(v_auth_time) < now() - interval '10 minutes' then
    raise exception 'Recent authentication required';
  end if;
  if p_confirmation is distinct from 'DELETE MY ACCOUNT' then raise exception 'Confirmation phrase does not match'; end if;
  insert into public.account_deletion_requests(user_id) values (auth.uid()) returning id into v_id;
  return v_id;
exception when unique_violation then raise exception 'An active account deletion request already exists';
end;
$$;
revoke all on function public.request_account_deletion(text) from public, anon;
grant execute on function public.request_account_deletion(text) to authenticated;

create function public.cancel_account_deletion(p_request_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  update public.account_deletion_requests
  set status = 'cancelled', cancelled_at = now(), updated_at = now()
  where id = p_request_id and user_id = auth.uid() and status = 'pending';
  return found;
end;
$$;
revoke all on function public.cancel_account_deletion(uuid) from public, anon;
grant execute on function public.cancel_account_deletion(uuid) to authenticated;

create function public.review_platform_report(p_report_id uuid, p_new_status text, p_decision text, p_internal_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_report public.platform_reports%rowtype; v_decision text; v_note text;
begin
  if auth.uid() is null or not public.is_platform_moderator() then raise exception 'Moderator access required'; end if;
  if p_new_status not in ('under_review', 'action_taken', 'dismissed', 'resolved') then raise exception 'Unsupported moderation status'; end if;
  v_decision := nullif(btrim(p_decision), ''); v_note := nullif(btrim(p_internal_note), '');
  if v_decision is null or char_length(v_decision) > 1000 or (v_note is not null and char_length(v_note) > 2000) then
    raise exception 'Decision or internal note is invalid';
  end if;
  select * into v_report from public.platform_reports where id = p_report_id for update;
  if not found then raise exception 'Report not found'; end if;
  insert into public.platform_report_actions(report_id, moderator_id, previous_status, new_status, decision, internal_note)
  values (v_report.id, auth.uid(), v_report.status, p_new_status, v_decision, v_note);
  update public.platform_reports set status = p_new_status, updated_at = now() where id = v_report.id;
end;
$$;
revoke all on function public.review_platform_report(uuid, text, text, text) from public, anon;
grant execute on function public.review_platform_report(uuid, text, text, text) to authenticated;

comment on table public.platform_moderators is 'Platform moderators are provisioned only by trusted administrators; no client write policy exists.';
comment on table public.platform_report_actions is 'Private moderation audit; internal notes are not visible to report submitters.';
comment on table public.account_deletion_requests is 'Requests are recorded for later reviewed processing; this schema does not delete accounts or retained records.';
