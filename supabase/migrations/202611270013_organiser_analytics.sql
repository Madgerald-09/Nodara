-- Private organiser analytics. Financial and attendance totals are aggregated
-- in PostgreSQL so the browser never receives payment or attendee records.
create index if not exists bookings_event_created_at_analytics_idx
  on public.bookings(event_id, created_at);
create index if not exists tickets_event_created_at_analytics_idx
  on public.tickets(event_id, created_at);
create index if not exists tickets_event_checkin_at_analytics_idx
  on public.tickets(event_id, checked_in_at)
  where status='checked_in';
create index if not exists tickets_type_created_at_analytics_idx
  on public.tickets(ticket_type_id, created_at);
create index if not exists payments_booking_verified_at_analytics_idx
  on public.payments(booking_id, verified_at)
  where status in ('successful','partially_refunded','refunded');
create index if not exists payment_refunds_payment_completed_at_analytics_idx
  on public.payment_refunds(payment_id, completed_at)
  where status='succeeded';

create or replace function public.get_organiser_analytics(
  p_from timestamptz,
  p_to timestamptz,
  p_event_id uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_event_ids uuid[];
  v_result jsonb;
begin
  if v_user_id is null then raise exception 'Sign in to view organiser analytics'; end if;
  if p_from is null or p_to is null or p_from >= p_to or p_to - p_from > interval '366 days' then
    raise exception 'Choose a valid reporting period of 366 days or less';
  end if;

  if p_event_id is not null and not exists (
    select 1 from public.events e where e.id = p_event_id and e.organizer_id = v_user_id
  ) then raise exception 'Event not found or access denied'; end if;

  select coalesce(array_agg(e.id), array[]::uuid[]) into v_event_ids
  from public.events e
  where e.organizer_id = v_user_id
    and (p_event_id is null or e.id = p_event_id);

  select jsonb_build_object(
    'generatedAt', now(),
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'events', (
      select jsonb_build_object(
        'total', count(*),
        'published', count(*) filter (where e.status = 'published'),
        'draft', count(*) filter (where e.status = 'draft'),
        'cancelled', count(*) filter (where e.status = 'cancelled'),
        'completed', count(*) filter (where e.status = 'completed'),
        'upcoming', count(*) filter (where e.start_date >= now() and e.status = 'published'),
        'past', count(*) filter (where coalesce(e.end_date, e.start_date) < now())
      ) from public.events e
      where e.id = any(v_event_ids) and e.created_at >= p_from and e.created_at < p_to
    ),
    'bookings', (
      select jsonb_build_object(
        'total', count(*),
        'confirmed', count(*) filter (where b.status = 'confirmed'),
        'pending', count(*) filter (where b.status in ('pending','payment_pending') and b.payment_status <> 'failed'),
        'failed', count(*) filter (where b.payment_status = 'failed'),
        'cancelled', count(*) filter (where b.status = 'cancelled'),
        'expired', count(*) filter (where b.status = 'expired')
      ) from public.bookings b
      where b.event_id = any(v_event_ids) and b.created_at >= p_from and b.created_at < p_to
    ),
    'tickets', (
      select jsonb_build_object(
        'issued', count(*) filter (where t.status in ('issued','checked_in') and b.status='confirmed' and b.payment_status in ('not_required','verified')),
        'validRemaining', count(*) filter (where t.status='issued' and b.status='confirmed' and b.payment_status in ('not_required','verified')
          and not exists (select 1 from public.payment_refund_items ri join public.payment_refunds rr on rr.id=ri.refund_id
            where ri.ticket_id=t.id and rr.status in ('pending','processing'))),
        'cancelled', count(*) filter (where t.status='cancelled'),
        'checkedIn', count(*) filter (where t.status='checked_in' and b.status='confirmed' and b.payment_status in ('not_required','verified'))
      ) from public.tickets t
      join public.bookings b on b.id=t.booking_id
      where t.event_id=any(v_event_ids) and t.created_at >= p_from and t.created_at < p_to
    ),
    'inventory', (
      select jsonb_build_object(
        'capacity', case when bool_or(tt.capacity is null) then null else coalesce(sum(tt.capacity),0) end,
        'unlimitedTypes', count(*) filter (where tt.capacity is null),
        'sold', coalesce(sum(tt.quantity_sold),0),
        'reserved', coalesce(sum(tt.quantity_reserved),0),
        'available', case when bool_or(tt.capacity is null) then null
          else coalesce(sum(greatest(tt.capacity - tt.quantity_sold - tt.quantity_reserved,0)),0) end
      ) from public.ticket_types tt where tt.event_id=any(v_event_ids)
    ),
    'eventOptions', (
      select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'title',e.title,'status',e.status,'location',e.location,'country',e.country) order by e.created_at desc), '[]'::jsonb)
      from (select e.id,e.title,e.status,e.location,e.country,e.created_at from public.events e
        where e.organizer_id=v_user_id order by e.created_at desc limit 200) e
    ),
    'financeByCurrency', (
      select coalesce(jsonb_agg(to_jsonb(f) order by f.currency), '[]'::jsonb) from (
        select p.currency,
          coalesce(sum(p.amount_minor) filter (where p.status in ('successful','partially_refunded','refunded') and p.verified_at >= p_from and p.verified_at < p_to and p.provider_transaction_id is not null),0)::bigint as gross_minor,
          (select coalesce(sum(r.amount_minor),0)::bigint
             from public.payment_refunds r join public.payments rp on rp.id=r.payment_id
             join public.bookings rb on rb.id=rp.booking_id
             where rb.event_id=any(v_event_ids) and r.currency=p.currency
               and r.status='succeeded' and r.completed_at >= p_from and r.completed_at < p_to) as refunded_minor,
          count(*) filter (where p.status in ('successful','partially_refunded','refunded') and p.verified_at >= p_from and p.verified_at < p_to and p.provider_transaction_id is not null) as successful_count,
          count(*) filter (where p.status='pending') as pending_count,
          count(*) filter (where p.status='failed') as failed_count,
          count(*) filter (where p.status='expired') as expired_count,
          (select count(*) from public.payment_refunds r join public.payments rp on rp.id=r.payment_id
             join public.bookings rb on rb.id=rp.booking_id
             where rb.event_id=any(v_event_ids) and r.currency=p.currency
               and r.status='succeeded' and r.completed_at >= p_from and r.completed_at < p_to) as completed_refund_count,
          (select count(*) from public.payment_refunds r join public.payments rp on rp.id=r.payment_id
             join public.bookings rb on rb.id=rp.booking_id
             where rb.event_id=any(v_event_ids) and r.currency=p.currency and r.status in ('pending','processing')
               and r.created_at >= p_from and r.created_at < p_to) as pending_refund_count,
          (select count(*) from public.payment_refunds r join public.payments rp on rp.id=r.payment_id
             join public.bookings rb on rb.id=rp.booking_id
             where rb.event_id=any(v_event_ids) and r.currency=p.currency and r.status='failed'
               and r.created_at >= p_from and r.created_at < p_to) as failed_refund_count,
          (select count(*) from public.payment_refunds r join public.payments rp on rp.id=r.payment_id
             join public.bookings rb on rb.id=rp.booking_id
             where rb.event_id=any(v_event_ids) and r.currency=p.currency and r.status='cancelled'
               and r.created_at >= p_from and r.created_at < p_to) as cancelled_refund_count
        from public.payments p join public.bookings b on b.id=p.booking_id
        where b.event_id=any(v_event_ids) and (
          (p.status in ('successful','partially_refunded','refunded') and p.verified_at >= p_from and p.verified_at < p_to)
          or (p.status in ('pending','failed','expired') and p.created_at >= p_from and p.created_at < p_to)
          or exists (select 1 from public.payment_refunds r where r.payment_id=p.id
            and ((r.status='succeeded' and r.completed_at >= p_from and r.completed_at < p_to)
              or (r.status in ('pending','processing') and r.created_at >= p_from and r.created_at < p_to)))
        )
        group by p.currency
      ) f
    ),
    'financeByEventCurrency', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.title,x.currency), '[]'::jsonb) from (
        select a.event_id,e.title,a.currency,sum(a.gross_minor)::bigint as gross_minor,
          sum(a.refunded_minor)::bigint as refunded_minor
        from (
          select b.event_id,p.currency,sum(p.amount_minor)::bigint as gross_minor,0::bigint as refunded_minor
          from public.payments p join public.bookings b on b.id=p.booking_id
          where b.event_id=any(v_event_ids) and p.status in ('successful','partially_refunded','refunded')
            and p.provider_transaction_id is not null and p.verified_at >= p_from and p.verified_at < p_to
          group by b.event_id,p.currency
          union all
          select b.event_id,r.currency,0::bigint,sum(r.amount_minor)::bigint
          from public.payment_refunds r join public.payments p on p.id=r.payment_id
          join public.bookings b on b.id=p.booking_id
          where b.event_id=any(v_event_ids) and r.status='succeeded' and r.completed_at >= p_from and r.completed_at < p_to
          group by b.event_id,r.currency
        ) a join public.events e on e.id=a.event_id
        group by a.event_id,e.title,a.currency
      ) x
    ),
    'paymentTrend', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.day,x.currency), '[]'::jsonb) from (
        select a.day::date as day,a.currency,sum(a.gross_minor)::bigint as gross_minor,
          sum(a.refunded_minor)::bigint as refunded_minor
        from (
          select date_trunc('day',p.verified_at) as day,p.currency,sum(p.amount_minor)::bigint as gross_minor,0::bigint as refunded_minor
          from public.payments p join public.bookings b on b.id=p.booking_id
          where b.event_id=any(v_event_ids) and p.status in ('successful','partially_refunded','refunded')
            and p.provider_transaction_id is not null and p.verified_at >= p_from and p.verified_at < p_to
          group by date_trunc('day',p.verified_at),p.currency
          union all
          select date_trunc('day',r.completed_at),r.currency,0::bigint,sum(r.amount_minor)::bigint
          from public.payment_refunds r join public.payments p on p.id=r.payment_id
          join public.bookings b on b.id=p.booking_id
          where b.event_id=any(v_event_ids) and r.status='succeeded' and r.completed_at >= p_from and r.completed_at < p_to
          group by date_trunc('day',r.completed_at),r.currency
        ) a group by a.day,a.currency
      ) x
    ),
    'eventsBreakdown', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.start_date desc), '[]'::jsonb) from (
        select e.id,e.title,e.status,e.start_date,e.currency,
          coalesce(bm.bookings,0) as bookings,
          coalesce(bm.confirmed_bookings,0) as confirmed_bookings,
          coalesce(bm.pending_bookings,0) as pending_bookings,
          coalesce(bm.failed_bookings,0) as failed_bookings,
          coalesce(tm.issued_tickets,0) as issued_tickets,
          coalesce(tm.checked_in_tickets,0) as checked_in_tickets,
          (select case when bool_or(tt.capacity is null) then null else coalesce(sum(tt.capacity),0) end
             from public.ticket_types tt where tt.event_id=e.id) as capacity,
          (select coalesce(sum(tt.quantity_sold),0) from public.ticket_types tt where tt.event_id=e.id) as sold,
          (select coalesce(sum(tt.quantity_reserved),0) from public.ticket_types tt where tt.event_id=e.id) as reserved
        from (select e.id,e.title,e.status,e.start_date,e.currency from public.events e
          where e.id=any(v_event_ids) order by e.start_date desc limit 200) e
        left join lateral (
          select count(*) filter (where b.created_at >= p_from and b.created_at < p_to) as bookings,
            count(*) filter (where b.status='confirmed' and b.created_at >= p_from and b.created_at < p_to) as confirmed_bookings,
            count(*) filter (where b.status in ('pending','payment_pending') and b.payment_status <> 'failed' and b.created_at >= p_from and b.created_at < p_to) as pending_bookings,
            count(*) filter (where b.payment_status='failed' and b.created_at >= p_from and b.created_at < p_to) as failed_bookings
          from public.bookings b where b.event_id=e.id
        ) bm on true
        left join lateral (
          select count(*) filter (where t.status in ('issued','checked_in') and b.status='confirmed'
              and b.payment_status in ('not_required','verified') and t.created_at >= p_from and t.created_at < p_to) as issued_tickets,
            count(*) filter (where t.status='checked_in' and b.status='confirmed'
              and b.payment_status in ('not_required','verified') and t.created_at >= p_from and t.created_at < p_to) as checked_in_tickets
          from public.tickets t join public.bookings b on b.id=t.booking_id where t.event_id=e.id
        ) tm on true
        order by e.start_date desc
      ) x
    ),
    'ticketTypes', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.issued desc), '[]'::jsonb) from (
        select tt.id,tt.name,tt.capacity,tt.quantity_sold as sold,tt.quantity_reserved as reserved,
          count(t.id) filter (where t.status in ('issued','checked_in') and b.status='confirmed' and b.payment_status in ('not_required','verified') and t.created_at >= p_from and t.created_at < p_to) as issued
        from public.ticket_types tt left join public.tickets t on t.ticket_type_id=tt.id
        left join public.bookings b on b.id=t.booking_id
        where tt.event_id=any(v_event_ids)
        group by tt.id order by issued desc limit 100
      ) x
    ),
    'bookingTrend', (
      select coalesce(jsonb_agg(to_jsonb(d) order by d.day), '[]'::jsonb) from (
        select days.day::date as day,
          coalesce(bd.confirmed,0) as confirmed,
          coalesce(bd.pending,0) as pending,
          coalesce(bd.cancelled,0) as cancelled
        from generate_series(date_trunc('day',p_from), date_trunc('day',p_to - interval '1 second'), interval '1 day') days(day)
        left join (
          select date_trunc('day',b.created_at) as day,
            count(*) filter (where b.status='confirmed') as confirmed,
            count(*) filter (where b.status in ('pending','payment_pending') and b.payment_status <> 'failed') as pending,
            count(*) filter (where b.status='cancelled') as cancelled
          from public.bookings b where b.event_id=any(v_event_ids) and b.created_at >= p_from and b.created_at < p_to
          group by date_trunc('day',b.created_at)
        ) bd on bd.day=days.day
      ) d
    ),
    'checkinTrend', (
      select coalesce(jsonb_agg(to_jsonb(d) order by d.day), '[]'::jsonb) from (
        select days.day::date as day, count(distinct ci.ticket_id) as checked_in
        from generate_series(date_trunc('day',p_from), date_trunc('day',p_to - interval '1 second'), interval '1 day') days(day)
        left join (
          select t.id as ticket_id,coalesce(h.verified_at,t.checked_in_at) as checked_at,t.event_id
          from public.tickets t left join public.ticket_checkin_history h on h.ticket_id=t.id
          where t.event_id=any(v_event_ids) and (t.status='checked_in' or h.ticket_id is not null)
            and coalesce(h.verified_at,t.checked_in_at) is not null
        ) ci on ci.event_id=any(v_event_ids) and ci.checked_at >= days.day and ci.checked_at < days.day + interval '1 day'
        group by days.day
      ) d
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_organiser_analytics(timestamptz,timestamptz,uuid) from public, anon;
grant execute on function public.get_organiser_analytics(timestamptz,timestamptz,uuid) to authenticated;
comment on function public.get_organiser_analytics(timestamptz,timestamptz,uuid) is
  'Returns private aggregate analytics for events owned by auth.uid(). Payment details and attendee identities are never returned.';
