-- Private event-driven notifications. Depends on migrations 260002-260004,
-- 270002, 270004 and 270011. Does not reference paused migration 270008.
create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  in_app_enabled jsonb not null default '{"bookings":true,"tickets":true,"payments":true,"refunds":true,"events":true,"reminders":true,"communities":true,"announcements":true,"organiser_updates":true}'::jsonb,
  email_enabled jsonb not null default '{"bookings":true,"tickets":true,"payments":true,"refunds":true,"events":true,"reminders":true,"communities":true,"announcements":true,"organiser_updates":true}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint notification_preferences_in_app_object check (jsonb_typeof(in_app_enabled)='object'),
  constraint notification_preferences_email_object check (jsonb_typeof(email_enabled)='object')
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in ('bookings','tickets','payments','refunds','events','reminders','communities','announcements','organiser_updates')),
  notification_type text not null check (char_length(notification_type) between 1 and 64),
  title text not null check (char_length(title) between 1 and 160),
  message text not null check (char_length(message) between 1 and 1000),
  related_resource_type text check (related_resource_type is null or related_resource_type in ('event','booking','ticket','announcement')),
  related_resource_id uuid,
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 240),
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context)='object' and octet_length(context::text)<=2048),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  read_at timestamptz,
  constraint notifications_id_recipient_unique unique(id,recipient_id),
  constraint notifications_resource_pair check ((related_resource_type is null)=(related_resource_id is null)),
  constraint notifications_expiry_after_creation check (expires_at is null or expires_at>created_at)
);
create index if not exists notifications_recipient_created_idx on public.notifications(recipient_id,created_at desc,id desc);
create index if not exists notifications_recipient_unread_idx on public.notifications(recipient_id,created_at desc) where read_at is null;
create index if not exists notifications_expiry_idx on public.notifications(expires_at) where expires_at is not null;

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('in_app','email')),
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','cancelled')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 8),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  provider_reference text check (provider_reference is null or char_length(provider_reference)<=200),
  safe_error_code text check (safe_error_code is null or safe_error_code ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_deliveries_unique_channel unique(notification_id,channel),
  constraint notification_deliveries_recipient_fk foreign key(notification_id,recipient_id)
    references public.notifications(id,recipient_id) on delete cascade,
  constraint notification_deliveries_processing_attempt check (status<>'processing' or last_attempt_at is not null)
);
create index if not exists notification_deliveries_due_idx on public.notification_deliveries(next_attempt_at,created_at)
  where channel='email' and status in ('pending','processing');

alter table public.notification_preferences enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_deliveries enable row level security;
revoke all on public.notification_preferences,public.notifications,public.notification_deliveries from public,anon,authenticated;
grant all on public.notification_preferences,public.notifications,public.notification_deliveries to service_role;
grant select on public.notification_preferences to authenticated;
grant select on public.notifications to authenticated;
grant update(read_at) on public.notifications to authenticated;
create policy notification_preferences_read_own on public.notification_preferences for select to authenticated
  using(user_id=(select auth.uid()));
create policy notifications_read_own on public.notifications for select to authenticated
  using(recipient_id=(select auth.uid()) and (expires_at is null or expires_at>now())
    and coalesce((select (p.in_app_enabled->>notifications.category)::boolean from public.notification_preferences p
      where p.user_id=(select auth.uid())),true)
    and (category<>'reminders' or exists(
      select 1 from public.events e join public.tickets t on t.event_id=e.id
      join public.bookings b on b.id=t.booking_id
      where e.id=notifications.related_resource_id and e.status='published'
        and e.start_date=(notifications.context->>'event_start_at')::timestamptz and e.start_date>now()
        and t.holder_user_id=(select auth.uid()) and t.status='issued'
        and b.status='confirmed' and b.payment_status in ('not_required','verified')
    )));
create policy notifications_update_read_own on public.notifications for update to authenticated
  using(recipient_id=(select auth.uid())) with check(recipient_id=(select auth.uid()));

create function public.set_notification_preferences(p_in_app jsonb,p_email jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_keys text[]:=array['bookings','tickets','payments','refunds','events','reminders','communities','announcements','organiser_updates'];
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_in_app is null or p_email is null or jsonb_typeof(p_in_app)<>'object' or jsonb_typeof(p_email)<>'object'
    or (select count(*) from jsonb_each(p_in_app))<>cardinality(v_keys)
    or (select count(*) from jsonb_each(p_email))<>cardinality(v_keys)
    or exists(select 1 from jsonb_each(p_in_app) x where not(x.key=any(v_keys)) or jsonb_typeof(x.value)<>'boolean')
    or exists(select 1 from jsonb_each(p_email) x where not(x.key=any(v_keys)) or jsonb_typeof(x.value)<>'boolean')
    or exists(select 1 from unnest(v_keys) k where (p_in_app ? k) is false or (p_email ? k) is false) then
    raise exception 'Notification preferences are invalid';
  end if;
  insert into public.notification_preferences(user_id,in_app_enabled,email_enabled,updated_at)
  values(auth.uid(),p_in_app,p_email,now()) on conflict(user_id) do update
    set in_app_enabled=excluded.in_app_enabled,email_enabled=excluded.email_enabled,updated_at=now();
end;
$$;
revoke all on function public.set_notification_preferences(jsonb,jsonb) from public,anon;
grant execute on function public.set_notification_preferences(jsonb,jsonb) to authenticated;

create function public.enqueue_user_notification(
  p_recipient uuid,p_category text,p_type text,p_title text,p_message text,
  p_resource_type text,p_resource_id uuid,p_idempotency_key text,p_context jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_pref public.notification_preferences%rowtype; v_id uuid;
begin
  if p_recipient is null or p_category not in ('bookings','tickets','payments','refunds','events','reminders','communities','announcements','organiser_updates')
    or p_title is null or char_length(p_title) not between 1 and 160 or p_message is null
    or char_length(p_message) not between 1 and 1000 or p_idempotency_key is null
    or char_length(p_idempotency_key) not between 1 and 240
    or (p_resource_type is not null and p_resource_type not in ('event','booking','ticket','announcement'))
    or p_context is null or jsonb_typeof(p_context)<>'object' or octet_length(p_context::text)>2048
    or ((p_resource_type is null) <> (p_resource_id is null)) then return null; end if;
  if p_resource_type='event' and not exists(select 1 from public.events e where e.id=p_resource_id) then return null; end if;
  if p_resource_type='booking' and not exists(select 1 from public.bookings b where b.id=p_resource_id) then return null; end if;
  if p_resource_type='ticket' and not exists(select 1 from public.tickets t where t.id=p_resource_id) then return null; end if;
  if p_resource_type='announcement' and not exists(select 1 from public.community_announcements a
    where a.id=p_resource_id and a.status='published' and a.published_at<=now()) then return null; end if;
  select * into v_pref from public.notification_preferences where user_id=p_recipient;
  if not coalesce((v_pref.in_app_enabled->>p_category)::boolean,true)
    and not coalesce((v_pref.email_enabled->>p_category)::boolean,true) then return null; end if;
  insert into public.notifications(recipient_id,category,notification_type,title,message,related_resource_type,related_resource_id,idempotency_key,context)
  values(p_recipient,p_category,p_type,p_title,p_message,p_resource_type,p_resource_id,p_idempotency_key,p_context)
  on conflict(idempotency_key) do nothing returning id into v_id;
  if v_id is null then return null; end if;
  if coalesce((v_pref.in_app_enabled->>p_category)::boolean,true) then
    insert into public.notification_deliveries(notification_id,recipient_id,channel,status,last_attempt_at)
    values(v_id,p_recipient,'in_app','sent',now()) on conflict(notification_id,channel) do nothing;
  end if;
  if coalesce((v_pref.email_enabled->>p_category)::boolean,true) then
    insert into public.notification_deliveries(notification_id,recipient_id,channel,status)
    values(v_id,p_recipient,'email','pending') on conflict(notification_id,channel) do nothing;
  end if;
  return v_id;
end;
$$;
revoke all on function public.enqueue_user_notification(uuid,text,text,text,text,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.enqueue_user_notification(uuid,text,text,text,text,text,uuid,text,jsonb) to service_role;

create function public.notify_booking_state_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_organizer uuid; v_ticket record;
begin
  if new.status='confirmed' and new.payment_status in ('not_required','verified')
    and (tg_op='INSERT' or old.status is distinct from new.status or old.payment_status is distinct from new.payment_status) then
    perform public.enqueue_user_notification(new.user_id,'bookings','booking_confirmed','Booking confirmed',
      'Your booking is confirmed. View its status in My Tickets.','booking',new.id,'booking-confirmed:'||new.id::text);
    select e.organizer_id into v_organizer from public.events e where e.id=new.event_id;
    if v_organizer is not null then
      perform public.enqueue_user_notification(v_organizer,'organiser_updates','organiser_booking_confirmed','New confirmed booking',
        'A booking for your event has been confirmed. Open your organiser dashboard to review event totals.','event',new.event_id,
        'organiser-booking-confirmed:'||new.id::text);
    end if;
    -- Paid-ticket rows are inserted inside the trusted payment finalizer before
    -- the booking itself transitions to confirmed. Revisit them here so those
    -- tickets receive the same notice as free tickets inserted afterwards.
    for v_ticket in select t.id,t.holder_user_id from public.tickets t
      where t.booking_id=new.id and t.status='issued' and t.holder_user_id is not null
    loop
      perform public.enqueue_user_notification(v_ticket.holder_user_id,'tickets','ticket_issued','Ticket issued',
        'A ticket for your experience is ready. View it securely in My Tickets.','ticket',v_ticket.id,'ticket-issued:'||v_ticket.id::text);
    end loop;
  elsif tg_op='UPDATE' and old.status is distinct from new.status and new.status in ('cancelled','expired') then
    perform public.enqueue_user_notification(new.user_id,'bookings','booking_'||new.status,
      case when new.status='expired' then 'Reservation expired' else 'Booking cancelled' end,
      case when new.status='expired' then 'Your unpaid reservation has expired.' else 'Your booking was cancelled.' end,
      'booking',new.id,'booking-'||new.status||':'||new.id::text);
  end if;
  return new;
end;
$$;
create trigger bookings_notify_state_change after insert or update of status,payment_status on public.bookings
  for each row execute function public.notify_booking_state_change();

create function public.notify_ticket_issued()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status='issued' and exists(select 1 from public.bookings b where b.id=new.booking_id and b.status='confirmed' and b.payment_status in ('not_required','verified')) then
    perform public.enqueue_user_notification(new.user_id,'tickets','ticket_issued','Ticket issued',
      'A ticket for your experience is ready. View it securely in My Tickets.','ticket',new.id,'ticket-issued:'||new.id::text);
  end if;
  return new;
end;
$$;
create trigger tickets_notify_issued after insert on public.tickets for each row execute function public.notify_ticket_issued();

create function public.notify_ticket_owner_or_status_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.holder_user_id is not null and new.holder_user_id is distinct from old.holder_user_id then
    perform public.enqueue_user_notification(new.holder_user_id,'tickets','ticket_transferred_in','Ticket transferred to you',
      'A verified ticket is now available in your account.','ticket',new.id,'ticket-transferred-in:'||new.id::text||':'||new.holder_user_id::text);
  end if;
  if old.holder_user_id is not null and new.holder_user_id is null
    and new.wallet_address is distinct from old.wallet_address
    and new.solana_transaction_signature is distinct from old.solana_transaction_signature then
    perform public.enqueue_user_notification(old.holder_user_id,'tickets','ticket_transfer_started','Ticket transfer recorded',
      'Your verified ticket transfer was recorded. The ticket will leave your active ticket list until its recipient claims it.',
      'ticket',new.id,'ticket-transfer-out:'||new.id::text||':'||coalesce(new.solana_transaction_signature,new.id::text));
  end if;
  if new.status='checked_in' and old.status is distinct from new.status and new.holder_user_id is not null then
    perform public.enqueue_user_notification(new.holder_user_id,'tickets','ticket_checked_in','Ticket checked in',
      'Your ticket was checked in for the event.','ticket',new.id,'ticket-checked-in:'||new.id::text);
  elsif new.status='cancelled' and old.status is distinct from new.status and new.holder_user_id is not null then
    perform public.enqueue_user_notification(new.holder_user_id,'tickets','ticket_cancelled','Ticket status updated',
      'A ticket in your account is no longer available. Review your booking for details.','ticket',new.id,'ticket-cancelled:'||new.id::text);
  end if;
  return new;
end;
$$;
create trigger tickets_notify_owner_or_status after update of holder_user_id,status on public.tickets
  for each row execute function public.notify_ticket_owner_or_status_change();

create function public.notify_payment_state_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_booking public.bookings%rowtype; v_category text; v_title text; v_message text;
begin
  if new.status is not distinct from old.status then return new; end if;
  select * into v_booking from public.bookings where id=new.booking_id;
  if not found then return new; end if;
  if new.status='successful' then v_category:='payments';v_title:='Payment verified';v_message:='Your payment was verified. Booking fulfillment status is shown in My Tickets.';
  elsif new.status='failed' then v_category:='payments';v_title:='Payment not completed';v_message:='Your payment attempt was not completed. Check your booking status before trying again.';
  else return new; end if;
  perform public.enqueue_user_notification(v_booking.user_id,v_category,'payment_'||new.status,v_title,v_message,'booking',v_booking.id,
    'payment-state:'||new.id::text||':'||new.status);
  return new;
end;
$$;
create trigger payments_notify_state_change after update of status on public.payments for each row execute function public.notify_payment_state_change();

create function public.notify_refund_state_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_booking public.bookings%rowtype;
begin
  if new.status is not distinct from old.status then return new; end if;
  select b.* into v_booking from public.bookings b join public.payments p on p.booking_id=b.id where p.id=new.payment_id;
  if not found then return new; end if;
  perform public.enqueue_user_notification(v_booking.user_id,'refunds','refund_'||new.status,
    case new.status when 'succeeded' then 'Refund completed' when 'failed' then 'Refund could not be completed' else 'Refund status updated' end,
    case new.status when 'succeeded' then 'Your refund was verified by the payment provider.' when 'failed' then 'The payment provider reported that your refund did not complete.' else 'Your refund is still being processed.' end,
    'booking',v_booking.id,'refund-state:'||new.id::text||':'||new.status);
  return new;
end;
$$;
create trigger payment_refunds_notify_state_change after update of status on public.payment_refunds
  for each row execute function public.notify_refund_state_change();

create function public.notify_event_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record; v_cancelled boolean;
begin
  v_cancelled:=new.status='cancelled' and old.status is distinct from new.status;
  if not v_cancelled and (new.status is distinct from 'published' or
    (old.title is not distinct from new.title and old.start_date is not distinct from new.start_date
      and old.end_date is not distinct from new.end_date and old.location is not distinct from new.location
      and old.venue is not distinct from new.venue and old.description is not distinct from new.description
      and old.category is not distinct from new.category and old.cover_image is not distinct from new.cover_image
      and old.country is not distinct from new.country and old.price is not distinct from new.price
      and old.currency is not distinct from new.currency and old.status is not distinct from new.status)) then return new; end if;
  for r in select distinct t.holder_user_id as user_id from public.tickets t join public.bookings b on b.id=t.booking_id
    where t.event_id=new.id and t.holder_user_id is not null and t.status in ('issued','checked_in') and b.status='confirmed'
      and b.payment_status in ('not_required','verified')
    union select distinct s.user_id from public.saved_events s where s.event_id=new.id
  loop
    perform public.enqueue_user_notification(r.user_id,'events',case when v_cancelled then 'event_cancelled' else 'event_updated' end,
      case when v_cancelled then 'Event cancelled' else 'Event details updated' end,
      case when v_cancelled then 'An event you saved or booked has been cancelled. Review its latest details in NODARA.' else 'An event you saved or booked has new details. Review the event page before attending.' end,
      'event',new.id,'event-change:'||new.id::text||':'||new.updated_at::text||':'||r.user_id::text);
  end loop;
  return new;
end;
$$;
create trigger events_notify_change after update of title,description,category,cover_image,location,venue,country,start_date,end_date,price,currency,status on public.events
  for each row execute function public.notify_event_change();

create function public.notify_community_announcement()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record; v_was_published boolean:=false;
begin
  if tg_op='UPDATE' then v_was_published:=old.status='published'; end if;
  if new.status<>'published' or new.published_at is null or new.published_at>now() or v_was_published then return new; end if;
  for r in select cm.user_id from public.community_members cm where cm.community_id=new.community_id loop
    perform public.enqueue_user_notification(r.user_id,'announcements','community_announcement_published','Community announcement',
      left(new.title,160),'announcement',new.id,'announcement-published:'||new.id::text||':'||r.user_id::text);
  end loop;
  return new;
end;
$$;
create trigger community_announcements_notify_publish after insert or update of status on public.community_announcements
  for each row execute function public.notify_community_announcement();

create function public.claim_notification_email_batch(p_limit integer default 50)
returns table(delivery_id uuid,notification_id uuid,recipient_id uuid,recipient_email text,
  title text,message text,resource_type text,resource_id uuid,idempotency_key text)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Trusted notification worker required'; end if;
  if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'Invalid batch size'; end if;
  update public.notification_deliveries d set status=case when d.attempt_count>=8 then 'failed' else 'pending' end,updated_at=now()
    where d.channel='email' and d.status='processing' and d.last_attempt_at<now()-interval '15 minutes';
  update public.notification_deliveries d set status='cancelled',updated_at=now()
    from public.notifications n join public.notification_preferences p on p.user_id=n.recipient_id
    where d.notification_id=n.id and d.channel='email' and d.status='pending'
      and not coalesce((p.email_enabled->>n.category)::boolean,true);
  update public.notification_deliveries d set status='cancelled',updated_at=now()
    from public.notifications n where d.notification_id=n.id and d.channel='email' and d.status='pending'
      and n.category='reminders' and not exists(
        select 1 from public.events e join public.tickets t on t.event_id=e.id join public.bookings b on b.id=t.booking_id
        where e.id=n.related_resource_id and e.status='published'
          and e.start_date=(n.context->>'event_start_at')::timestamptz and e.start_date>now()
          and t.holder_user_id=n.recipient_id and t.status='issued'
          and b.status='confirmed' and b.payment_status in ('not_required','verified')
      );
  update public.notification_deliveries d set status='cancelled',updated_at=now()
    where d.channel='email' and d.status='pending' and not exists(select 1 from auth.users u where u.id=d.recipient_id and u.email is not null);
  return query with chosen as (
    select d.id from public.notification_deliveries d where d.channel='email' and d.status='pending'
      and d.next_attempt_at<=now() and d.attempt_count<8 order by d.next_attempt_at,d.created_at
      limit p_limit for update skip locked
  ), claimed as (
    update public.notification_deliveries d set status='processing',attempt_count=d.attempt_count+1,
      last_attempt_at=now(),updated_at=now() from chosen c where d.id=c.id
    returning d.id,d.notification_id,d.recipient_id
  )
  select c.id,n.id,c.recipient_id,u.email::text,n.title,n.message,n.related_resource_type,n.related_resource_id,n.idempotency_key
    from claimed c join public.notifications n on n.id=c.notification_id join auth.users u on u.id=c.recipient_id
    where u.email is not null;
end;
$$;
revoke all on function public.claim_notification_email_batch(integer) from public,anon,authenticated;
grant execute on function public.claim_notification_email_batch(integer) to service_role;

create function public.finish_notification_email_delivery(p_delivery_id uuid,p_sent boolean,p_retryable boolean,p_provider_reference text,p_safe_error_code text)
returns text language plpgsql security definer set search_path = '' as $$
declare v public.notification_deliveries%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Trusted notification worker required'; end if;
  select * into v from public.notification_deliveries where id=p_delivery_id and channel='email' for update;
  if not found then raise exception 'Delivery not found'; end if;
  if v.status in ('sent','cancelled','failed') then return v.status; end if;
  if v.status<>'processing' then raise exception 'Delivery is not claimed'; end if;
  if p_sent is null or p_retryable is null then raise exception 'Delivery result is invalid'; end if;
  if p_sent then
    if p_provider_reference is null or char_length(p_provider_reference) not between 1 and 200 then raise exception 'Provider reference is required'; end if;
    update public.notification_deliveries set status='sent',provider_reference=nullif(left(p_provider_reference,200),''),safe_error_code=null,updated_at=now() where id=v.id;
    return 'sent';
  end if;
  if p_safe_error_code is null or p_safe_error_code !~ '^[A-Z0-9_]{1,64}$' then raise exception 'Invalid safe error code'; end if;
  update public.notification_deliveries set status=case when not p_retryable or v.attempt_count>=8 then 'failed' else 'pending' end,
    next_attempt_at=case when not p_retryable or v.attempt_count>=8 then v.next_attempt_at else now()+make_interval(secs=>least(21600,30*power(2,greatest(v.attempt_count-1,0))::integer)) end,
    safe_error_code=p_safe_error_code,updated_at=now() where id=v.id;
  return case when not p_retryable or v.attempt_count>=8 then 'failed' else 'pending' end;
end;
$$;
revoke all on function public.finish_notification_email_delivery(uuid,boolean,boolean,text,text) from public,anon,authenticated;
grant execute on function public.finish_notification_email_delivery(uuid,boolean,boolean,text,text) to service_role;

create function public.enqueue_due_event_reminders()
returns integer language plpgsql security definer set search_path = '' as $$
declare r record; v_count integer:=0; v_slot text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Trusted reminder worker required'; end if;
  for r in select distinct t.holder_user_id as user_id,e.id event_id,e.title,e.start_date
    from public.tickets t join public.bookings b on b.id=t.booking_id join public.events e on e.id=t.event_id
    where t.status='issued' and t.holder_user_id is not null and b.status='confirmed' and b.payment_status in ('not_required','verified')
      and e.status='published' and e.start_date>now()
      and ((e.start_date>now()+interval '23 hours' and e.start_date<=now()+interval '24 hours')
        or (e.start_date>now()+interval '1 hour' and e.start_date<=now()+interval '2 hours'))
  loop
    v_slot:=case when r.start_date<=now()+interval '2 hours' then '2h' else '24h' end;
    if public.enqueue_user_notification(r.user_id,'reminders','event_reminder_'||v_slot,
      case when v_slot='2h' then 'Your event is coming up' else 'Your event is tomorrow' end,
      left(r.title,700)||' starts at '||to_char(r.start_date at time zone 'UTC','YYYY-MM-DD HH24:MI')||' UTC.',
      'event',r.event_id,'event-reminder:'||r.event_id::text||':'||r.user_id::text||':'||v_slot||':'||r.start_date::text,
      jsonb_build_object('event_start_at',r.start_date)) is not null then
      v_count:=v_count+1;
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.enqueue_due_event_reminders() from public,anon,authenticated;
grant execute on function public.enqueue_due_event_reminders() to service_role;

comment on table public.notifications is 'Private notifications generated by trusted database transitions. Clients have no insert or delete grant.';
comment on table public.notification_deliveries is 'Private delivery queue and diagnostics; service-role only.';
comment on function public.enqueue_due_event_reminders() is 'Service-role-only hourly reminder enqueue for confirmed bookings with current issued tickets.';
