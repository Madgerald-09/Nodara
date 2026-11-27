-- Phase 12 integration metadata and atomic per-user provider rate limits.
-- Additive only; do not mark applied until reviewed and deployed separately.
alter table public.events
  add column if not exists source_url text,
  add column if not exists registration_url text;

do $$ begin
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'events_source_url_https_check' and conrelid = 'public.events'::regclass) then
    alter table public.events add constraint events_source_url_https_check
      check (source_url is null or (source_url ~ '^https://[^[:space:]]+$' and length(source_url) <= 2048));
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'events_registration_url_https_check' and conrelid = 'public.events'::regclass) then
    alter table public.events add constraint events_registration_url_https_check
      check (registration_url is null or (registration_url ~ '^https://[^[:space:]]+$' and length(registration_url) <= 2048));
  end if;
end $$;

create table if not exists public.ai_provider_rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('firecrawl', 'elevenlabs_tts', 'elevenlabs_stt')),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count >= 0),
  primary key (user_id, provider)
);
alter table public.ai_provider_rate_limits enable row level security;
alter table public.ai_provider_rate_limits force row level security;
revoke all on public.ai_provider_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on public.ai_provider_rate_limits to service_role;

create or replace function public.consume_ai_provider_request(
  p_user_id uuid, p_provider text, p_limit integer, p_window_seconds integer
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare allowed boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_provider not in ('firecrawl','elevenlabs_tts','elevenlabs_stt')
     or p_limit < 1 or p_limit > 100 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid rate limit request' using errcode = '22023';
  end if;
  insert into public.ai_provider_rate_limits as current_limit(user_id,provider,window_started_at,request_count)
    values (p_user_id,p_provider,pg_catalog.clock_timestamp(),1)
  on conflict (user_id,provider) do update set
    window_started_at = case when current_limit.window_started_at <= pg_catalog.clock_timestamp() - pg_catalog.make_interval(secs => p_window_seconds)
      then pg_catalog.clock_timestamp() else current_limit.window_started_at end,
    request_count = case when current_limit.window_started_at <= pg_catalog.clock_timestamp() - pg_catalog.make_interval(secs => p_window_seconds)
      then 1 else current_limit.request_count + 1 end
  returning request_count <= p_limit into allowed;
  return allowed;
end;
$$;
revoke all on function public.consume_ai_provider_request(uuid,text,integer,integer) from public, anon, authenticated;
grant execute on function public.consume_ai_provider_request(uuid,text,integer,integer) to service_role;
