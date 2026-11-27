-- Trending only exposes event order and public community cards, never user-level
-- saves, bookings, check-ins, or membership rows.

create index if not exists saved_events_trending_created_idx
  on public.saved_events (created_at, event_id, user_id);
create index if not exists bookings_trending_confirmed_created_idx
  on public.bookings (created_at, event_id, user_id)
  where status = 'confirmed';
create index if not exists tickets_trending_checkin_idx
  on public.tickets (checked_in_at, event_id, holder_user_id)
  where status = 'checked_in' and holder_user_id is not null;
create index if not exists community_members_trending_joined_idx
  on public.community_members (joined_at, community_id, user_id);

create function public.get_trending_event_ranks(p_period text default 'week')
returns table (event_id uuid, trending_rank integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_period is null or p_period not in ('week', 'month', 'all_time') then
    raise exception 'Unsupported trending period';
  end if;

  return query
  with settings as (
    select pg_catalog.now() as now_at,
      case p_period
        when 'week' then pg_catalog.now() - interval '7 days'
        when 'month' then pg_catalog.now() - interval '30 days'
        else null::timestamptz
      end as window_start
  ), activity as (
    select s.event_id, s.user_id as actor_id, 'save'::text as signal_type, s.created_at as happened_at
    from public.saved_events s cross join settings x
    where p_period <> 'all_time' and s.created_at >= x.window_start
    union all
    select b.event_id, b.user_id, 'booking'::text, b.created_at
    from public.bookings b cross join settings x
    where b.status = 'confirmed' and (p_period = 'all_time' or b.created_at >= x.window_start)
    union all
    select t.event_id, t.holder_user_id, 'checkin'::text, t.checked_in_at
    from public.tickets t cross join settings x
    where t.status = 'checked_in' and t.checked_in_at is not null and t.holder_user_id is not null
      and (p_period = 'all_time' or t.checked_in_at >= x.window_start)
  ), deduplicated as (
    -- One person can contribute at most once per event and signal type per period.
    -- Multiple bookings or checked-in ticket rows therefore cannot inflate a score.
    select a.event_id, a.actor_id, a.signal_type, pg_catalog.max(a.happened_at) as happened_at
    from activity a
    where a.actor_id is not null
    group by a.event_id, a.actor_id, a.signal_type
  ), scored as (
    select d.event_id,
      pg_catalog.sum(
        case d.signal_type when 'save' then 1.0 when 'booking' then 3.0 else 4.0 end
        * case when p_period = 'all_time' then 1.0 else
            pg_catalog.least(1.0, pg_catalog.greatest(0.1,
              1.0 - extract(epoch from (x.now_at - d.happened_at))
                / extract(epoch from (x.now_at - x.window_start))))
          end
      ) as score
    from deduplicated d cross join settings x
    group by d.event_id
  ), ranked as (
    select e.id as event_id,
      pg_catalog.row_number() over (order by s.score desc, e.start_date asc, e.created_at desc)::integer as position
    from scored s join public.events e on e.id = s.event_id
    where e.status = 'published' and e.start_date > pg_catalog.now()
  )
  select r.event_id, r.position from ranked r where r.position <= 24;
end;
$$;

revoke all on function public.get_trending_event_ranks(text) from public, anon, authenticated;
grant execute on function public.get_trending_event_ranks(text) to anon, authenticated;
grant execute on function public.get_trending_event_ranks(text) to service_role;

create function public.get_trending_communities(p_period text default 'week')
returns table (
  id uuid, name text, slug text, description text, category text,
  cover_image text, location text, created_at timestamptz, member_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_period is null or p_period not in ('week', 'month') then
    raise exception 'Community trending supports week or month only';
  end if;

  return query
  with recent_members as (
    select cm.community_id, pg_catalog.count(distinct cm.user_id)::bigint as recent_count
    from public.community_members cm
    where cm.joined_at >= pg_catalog.now() - case p_period when 'week' then interval '7 days' else interval '30 days' end
    group by cm.community_id
  ), current_members as (
    select cm.community_id, pg_catalog.count(*)::bigint as member_count
    from public.community_members cm group by cm.community_id
  )
  select c.id, c.name, c.slug, c.description, c.category, c.cover_image, c.location, c.created_at,
    coalesce(m.member_count, 0)::bigint
  from recent_members r join public.communities c on c.id = r.community_id
  left join current_members m on m.community_id = c.id
  order by r.recent_count desc, coalesce(m.member_count, 0) desc, c.created_at desc
  limit 8;
end;
$$;

revoke all on function public.get_trending_communities(text) from public, anon, authenticated;
grant execute on function public.get_trending_communities(text) to anon, authenticated;
grant execute on function public.get_trending_communities(text) to service_role;
