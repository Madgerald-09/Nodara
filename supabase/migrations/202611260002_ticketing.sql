-- NODARA ticketing foundation. No payment provider or on-chain behavior is enabled here.
create table public.ticket_types (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 100),
  description text check (description is null or char_length(description) <= 500),
  price numeric(12,2) not null default 0 check (price >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  capacity integer check (capacity is null or capacity > 0),
  quantity_sold integer not null default 0 check (quantity_sold >= 0),
  quantity_reserved integer not null default 0 check (quantity_reserved >= 0),
  max_per_booking integer not null default 10 check (max_per_booking between 1 and 20),
  active boolean not null default true,
  sales_start timestamptz,
  sales_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ticket_types_sales_window check (sales_end is null or sales_start is null or sales_end > sales_start)
);
create unique index ticket_types_one_name_per_event on public.ticket_types(event_id, lower(name));
create index ticket_types_event_active_idx on public.ticket_types(event_id, active);

create table public.booking_items (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  ticket_type_id uuid not null references public.ticket_types(id) on delete restrict,
  quantity integer not null check (quantity between 1 and 20),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  unique (booking_id, ticket_type_id)
);
create index booking_items_ticket_type_idx on public.booking_items(ticket_type_id);

alter table public.bookings add column booking_reference text;
alter table public.bookings add column payment_status text not null default 'not_required'
  check (payment_status in ('not_required', 'pending', 'verified', 'failed', 'refunded'));
alter table public.bookings add column expires_at timestamptz;
alter table public.bookings add column payment_provider text;
alter table public.bookings add column payment_reference text;
alter table public.bookings add column solana_network text;
alter table public.bookings add column solana_transaction_signature text;
update public.bookings set booking_reference = 'NOD-' || upper(substr(replace(id::text, '-', ''), 1, 12)) where booking_reference is null;
alter table public.bookings alter column booking_reference set not null;
alter table public.bookings alter column booking_reference set default ('NOD-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)));
create unique index bookings_reference_unique on public.bookings(booking_reference);
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in ('pending', 'payment_pending', 'confirmed', 'cancelled', 'expired'));
-- Retire the old client-price insert/update trigger before migrating legacy pending requests.
drop trigger if exists bookings_validate on public.bookings;

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  booking_item_id uuid not null references public.booking_items(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  ticket_type_id uuid not null references public.ticket_types(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete cascade,
  qr_token uuid not null unique default gen_random_uuid(),
  status text not null default 'issued' check (status in ('issued', 'checked_in', 'cancelled')),
  checked_in_at timestamptz,
  checked_in_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  solana_network text,
  solana_asset_address text,
  solana_transaction_signature text,
  wallet_address text,
  blockchain_status text not null default 'off_chain'
    check (blockchain_status in ('off_chain', 'pending', 'verified', 'failed')),
  constraint tickets_checkin_fields check ((status = 'checked_in') = (checked_in_at is not null))
);
create index tickets_user_event_idx on public.tickets(user_id, event_id, created_at desc);
create index tickets_event_status_idx on public.tickets(event_id, status);
create index tickets_booking_idx on public.tickets(booking_id);

-- Initialize one General Admission tier for existing and newly created events.
insert into public.ticket_types(event_id, name, price, currency, capacity)
select e.id, 'General Admission', e.price, e.currency, e.capacity
from public.events e
where not exists (select 1 from public.ticket_types tt where tt.event_id = e.id);

-- Keep legacy pending requests from bypassing the new capacity counters. They become
-- unpaid reservations with a short expiry; this does not mark them confirmed or paid.
insert into public.booking_items(booking_id,ticket_type_id,quantity,unit_price,currency)
select b.id,tt.id,b.quantity,b.total_amount / b.quantity,b.currency
from public.bookings b join public.ticket_types tt on tt.event_id=b.event_id
where b.status='pending' and tt.name='General Admission';
update public.ticket_types tt
set quantity_reserved = coalesce((select sum(bi.quantity)::integer from public.booking_items bi
  join public.bookings b on b.id=bi.booking_id where bi.ticket_type_id=tt.id and b.status='pending'),0);
update public.bookings set status='payment_pending',payment_status='pending',expires_at=now()+interval '15 minutes'
where status='pending';

create or replace function public.create_default_ticket_type()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.ticket_types tt where tt.event_id = new.id) then
    insert into public.ticket_types(event_id, name, price, currency, capacity)
    values (new.id, 'General Admission', new.price, new.currency, new.capacity);
  end if;
  return new;
end;
$$;
create trigger events_create_default_ticket_type after insert on public.events
for each row execute function public.create_default_ticket_type();

create function public.ticket_types_updated_at()
returns trigger language plpgsql set search_path = '' as $$ begin new.updated_at := now(); return new; end; $$;
create trigger ticket_types_updated_at before update on public.ticket_types
for each row execute function public.ticket_types_updated_at();

create function public.guard_ticket_inventory()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.quantity_sold is distinct from old.quantity_sold or new.quantity_reserved is distinct from old.quantity_reserved)
    and current_setting('nodara.ticket_inventory_write', true) is distinct from 'on' then
    raise exception 'Ticket inventory is managed by booking functions';
  end if;
  if new.capacity is not null and new.quantity_sold + new.quantity_reserved > new.capacity then
    raise exception 'Capacity cannot be lower than tickets sold and reserved';
  end if;
  if new.event_id is distinct from old.event_id and exists(select 1 from public.booking_items bi where bi.ticket_type_id=old.id) then
    raise exception 'Ticket types with bookings cannot be moved to another event';
  end if;
  return new;
end;
$$;
create trigger ticket_types_inventory_guard before update on public.ticket_types
for each row execute function public.guard_ticket_inventory();

create function public.sync_general_admission_tier()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_inventory bigint;
begin
  if new.price is distinct from old.price or new.currency is distinct from old.currency or new.capacity is distinct from old.capacity then
    if new.capacity is not null then
      select coalesce(sum(tt.quantity_sold + tt.quantity_reserved),0) into v_inventory
      from public.ticket_types tt where tt.event_id=new.id;
      if v_inventory > new.capacity then raise exception 'Event capacity cannot be lower than tickets sold and reserved'; end if;
    end if;
    update public.ticket_types set price=new.price,currency=new.currency,capacity=new.capacity
    where event_id=new.id and lower(name)='general admission';
  end if;
  return new;
end;
$$;
create trigger events_sync_general_admission after update on public.events
for each row execute function public.sync_general_admission_tier();

-- Replace the earlier single-price insert trigger. Direct client inserts are revoked below;
-- immutable booking fields and controlled cancellation remain enforced for any allowed update.
create or replace function public.prepare_booking()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id
    or new.event_id is distinct from old.event_id
    or new.user_id is distinct from old.user_id
    or new.quantity is distinct from old.quantity
    or new.total_amount is distinct from old.total_amount
    or new.currency is distinct from old.currency
    or new.booking_reference is distinct from old.booking_reference
    or new.created_at is distinct from old.created_at
    or new.payment_status is distinct from old.payment_status
    or new.expires_at is distinct from old.expires_at
    or new.payment_provider is distinct from old.payment_provider
    or new.payment_reference is distinct from old.payment_reference
    or new.solana_network is distinct from old.solana_network
    or new.solana_transaction_signature is distinct from old.solana_transaction_signature
    or not ((old.status in ('pending', 'payment_pending') and new.status = 'cancelled')
      or (old.status = 'payment_pending' and new.status = 'expired')) then
    raise exception 'Booking fields are protected';
  end if;
  return new;
end;
$$;
create trigger bookings_validate_update before update on public.bookings
for each row execute function public.prepare_booking();

create function public.expire_event_reservations(p_event_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare b record;
begin
  perform set_config('nodara.ticket_inventory_write','on',true);
  for b in select id from public.bookings
    where event_id = p_event_id and status = 'payment_pending' and expires_at <= now()
    for update
  loop
    update public.ticket_types tt
      set quantity_reserved = greatest(0, tt.quantity_reserved - bi.quantity)
      from public.booking_items bi
      where bi.booking_id = b.id and tt.id = bi.ticket_type_id;
    update public.bookings set status = 'expired' where id = b.id;
  end loop;
end;
$$;

create function public.get_event_ticket_types(p_event_id uuid)
returns table(id uuid, name text, description text, price numeric, currency text, remaining integer, max_per_booking integer)
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.events e where e.id = p_event_id and e.status = 'published') then
    return;
  end if;
  perform public.expire_event_reservations(p_event_id);
  return query
    select tt.id, tt.name, tt.description, tt.price, tt.currency,
      case when tt.capacity is null then null else greatest(0, tt.capacity - tt.quantity_sold - tt.quantity_reserved) end,
      tt.max_per_booking
    from public.ticket_types tt
    where tt.event_id = p_event_id and tt.active
      and (tt.sales_start is null or tt.sales_start <= now())
      and (tt.sales_end is null or tt.sales_end > now())
    order by tt.price, tt.created_at;
end;
$$;

create function public.create_booking(p_event_id uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid(); v_event public.events%rowtype; v_item jsonb;
  v_type public.ticket_types%rowtype; v_qty integer; v_total numeric(12,2) := 0;
  v_count integer := 0; v_currency text; v_booking public.bookings%rowtype;
  v_item_id uuid; v_status text; v_expiry timestamptz;
  v_event_total integer; v_event_reserved integer;
begin
  if v_user is null then raise exception 'Sign in to book tickets'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 10 then
    raise exception 'Choose between one and ten ticket types';
  end if;
  if exists(select 1 from jsonb_array_elements(p_items) as chosen(item)
    group by item->>'ticket_type_id' having count(*) > 1) then
    raise exception 'Each ticket type can only appear once';
  end if;
  select * into v_event from public.events where id = p_event_id and status = 'published' for update;
  if not found then raise exception 'Event is not available for booking'; end if;
  perform public.expire_event_reservations(p_event_id);
  for v_item in select value from jsonb_array_elements(p_items) loop
    if (v_item->>'ticket_type_id') is null or (v_item->>'quantity') is null or (v_item->>'quantity') !~ '^[0-9]+$' then raise exception 'Invalid ticket selection'; end if;
    v_qty := (v_item->>'quantity')::integer;
    if v_qty < 1 or v_qty > 20 then raise exception 'Ticket quantity is out of range'; end if;
    select * into v_type from public.ticket_types where id = (v_item->>'ticket_type_id')::uuid
      and event_id = p_event_id and active for update;
    if not found then raise exception 'Ticket type is unavailable'; end if;
    if v_qty > v_type.max_per_booking then raise exception 'Ticket limit exceeded'; end if;
    if (v_type.sales_start is not null and v_type.sales_start > now()) or (v_type.sales_end is not null and v_type.sales_end <= now()) then
      raise exception 'Ticket sales are closed';
    end if;
    if v_type.capacity is not null and v_type.quantity_sold + v_type.quantity_reserved + v_qty > v_type.capacity then
      raise exception 'Not enough tickets remain';
    end if;
    if v_currency is not null and v_currency <> v_type.currency then raise exception 'Ticket currencies must match'; end if;
    v_currency := v_type.currency;
    v_total := v_total + v_type.price * v_qty;
    v_count := v_count + v_qty;
  end loop;
  if v_count > 20 then raise exception 'A booking can contain at most 20 tickets'; end if;
  if v_event.capacity is not null then
    select coalesce(sum(tt.quantity_sold),0)::integer, coalesce(sum(tt.quantity_reserved),0)::integer
      into v_event_total, v_event_reserved from public.ticket_types tt where tt.event_id = p_event_id;
    if v_event_total + v_event_reserved + v_count > v_event.capacity then raise exception 'Event capacity has been reached'; end if;
  end if;
  v_status := case when v_total = 0 then 'confirmed' else 'payment_pending' end;
  v_expiry := case when v_total = 0 then null else now() + interval '15 minutes' end;
  perform set_config('nodara.ticket_inventory_write','on',true);
  insert into public.bookings(event_id,user_id,quantity,total_amount,currency,status,payment_status,expires_at)
    values(p_event_id,v_user,v_count,v_total,coalesce(v_currency,v_event.currency),v_status,
      case when v_total = 0 then 'not_required' else 'pending' end,v_expiry)
    returning * into v_booking;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::integer;
    select * into v_type from public.ticket_types where id = (v_item->>'ticket_type_id')::uuid and event_id = p_event_id for update;
    insert into public.booking_items(booking_id,ticket_type_id,quantity,unit_price,currency)
      values(v_booking.id,v_type.id,v_qty,v_type.price,v_type.currency) returning id into v_item_id;
    if v_total = 0 then
      update public.ticket_types set quantity_sold = quantity_sold + v_qty where id = v_type.id;
      insert into public.tickets(booking_id,booking_item_id,event_id,ticket_type_id,user_id)
        select v_booking.id,v_item_id,p_event_id,v_type.id,v_user from generate_series(1,v_qty);
    else
      update public.ticket_types set quantity_reserved = quantity_reserved + v_qty where id = v_type.id;
    end if;
  end loop;
  return jsonb_build_object('booking_id',v_booking.id,'booking_reference',v_booking.booking_reference,
    'status',v_booking.status,'payment_status',v_booking.payment_status,'total_amount',v_booking.total_amount,
    'currency',v_booking.currency,'expires_at',v_booking.expires_at,'ticket_count',case when v_total = 0 then v_count else 0 end);
end;
$$;

create function public.get_my_tickets()
returns table(ticket_id uuid, qr_token uuid, ticket_status text, created_at timestamptz,
  booking_reference text, booking_status text, payment_status text, event_id uuid, event_title text,
  event_start timestamptz, event_end timestamptz, location text, venue text, cover_image text,
  ticket_type text, blockchain_status text)
language sql stable security definer set search_path = '' as $$
  select t.id,t.qr_token,t.status,t.created_at,b.booking_reference,b.status,b.payment_status,e.id,e.title,
    e.start_date,e.end_date,e.location,e.venue,e.cover_image,tt.name,t.blockchain_status
  from public.tickets t join public.bookings b on b.id=t.booking_id
  join public.events e on e.id=t.event_id join public.ticket_types tt on tt.id=t.ticket_type_id
  where t.user_id=auth.uid() and b.status='confirmed' order by e.start_date;
$$;

create function public.get_my_bookings()
returns table(id uuid, booking_reference text, status text, payment_status text, total_amount numeric,
  currency text, expires_at timestamptz, created_at timestamptz, event_id uuid,
  event_title text, event_start timestamptz, event_location text, event_cover_image text)
language plpgsql security definer set search_path = '' as $$
declare e record;
begin
  if auth.uid() is null then raise exception 'Sign in to view bookings'; end if;
  for e in select distinct b.event_id from public.bookings b
    where b.user_id=auth.uid() and b.status='payment_pending' and b.expires_at <= now()
  loop
    perform public.expire_event_reservations(e.event_id);
  end loop;
  return query select b.id,b.booking_reference,b.status,b.payment_status,b.total_amount,b.currency,b.expires_at,
    b.created_at,b.event_id,ev.title,ev.start_date,ev.location,ev.cover_image
  from public.bookings b join public.events ev on ev.id=b.event_id
  where b.user_id=auth.uid() order by b.created_at desc;
end;
$$;

create function public.get_event_attendees(p_event_id uuid)
returns table(ticket_id uuid, booking_reference text, attendee_name text, attendee_email text,
  ticket_type text, quantity integer, booking_status text, ticket_status text, checked_in_at timestamptz, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.events where id=p_event_id and organizer_id=auth.uid()) then
    raise exception 'Event not found or access denied';
  end if;
  return query select t.id,b.booking_reference,p.full_name,au.email,tt.name,1::integer,b.status,t.status,t.checked_in_at,b.created_at
    from public.tickets t join public.bookings b on b.id=t.booking_id
    join public.profiles p on p.id=t.user_id join auth.users au on au.id=t.user_id
    join public.ticket_types tt on tt.id=t.ticket_type_id
    where t.event_id=p_event_id and b.status='confirmed' order by b.created_at desc;
end;
$$;

create function public.check_in_ticket(p_event_id uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ticket public.tickets%rowtype;
begin
  if not exists(select 1 from public.events where id=p_event_id and organizer_id=auth.uid()) then
    raise exception 'Event not found or access denied';
  end if;
  if p_code is null or length(p_code)>100 then return jsonb_build_object('result','invalid'); end if;
  select * into v_ticket from public.tickets
    where event_id=p_event_id and (qr_token::text=p_code or id::text=p_code) for update;
  if not found then return jsonb_build_object('result','invalid'); end if;
  if v_ticket.status='cancelled' then return jsonb_build_object('result','cancelled'); end if;
  if v_ticket.status='checked_in' then return jsonb_build_object('result','already_used','checked_in_at',v_ticket.checked_in_at); end if;
  if not exists(select 1 from public.bookings where id=v_ticket.booking_id and status='confirmed') then
    return jsonb_build_object('result','invalid');
  end if;
  update public.tickets set status='checked_in',checked_in_at=now(),checked_in_by=auth.uid() where id=v_ticket.id;
  return jsonb_build_object('result','valid','ticket_id',v_ticket.id);
end;
$$;

alter table public.ticket_types enable row level security;
alter table public.booking_items enable row level security;
alter table public.tickets enable row level security;
create policy "Published ticket types are public" on public.ticket_types for select to anon,authenticated
  using (active and exists(select 1 from public.events e where e.id=event_id and e.status='published'));
create policy "Organisers manage ticket types for own events" on public.ticket_types for all to authenticated
  using (exists(select 1 from public.events e where e.id=event_id and e.organizer_id=auth.uid()))
  with check (exists(select 1 from public.events e where e.id=event_id and e.organizer_id=auth.uid()));
create policy "Booking owners and event organisers read items" on public.booking_items for select to authenticated
  using (exists(select 1 from public.bookings b where b.id=booking_id and b.user_id=auth.uid()) or
    exists(select 1 from public.bookings b join public.events e on e.id=b.event_id where b.id=booking_id and e.organizer_id=auth.uid()));
create policy "Ticket owners and event organisers read ticket records" on public.tickets for select to authenticated
  using (user_id=auth.uid() or exists(select 1 from public.events e where e.id=event_id and e.organizer_id=auth.uid()));

revoke all on public.ticket_types,public.booking_items,public.tickets from public,anon,authenticated;
grant all on public.ticket_types,public.booking_items,public.tickets to service_role;
grant select on public.ticket_types to anon,authenticated;
grant insert (event_id,name,description,price,currency,capacity,max_per_booking,active,sales_start,sales_end) on public.ticket_types to authenticated;
grant update (name,description,price,currency,capacity,max_per_booking,active,sales_start,sales_end) on public.ticket_types to authenticated;
grant delete on public.ticket_types to authenticated;
grant select on public.booking_items,public.tickets to authenticated;
-- Booking inserts are only possible through create_booking(), which derives the caller from auth.uid().
revoke insert on public.bookings from anon,authenticated;
revoke insert (event_id,user_id,quantity,total_amount,currency,status) on public.bookings from authenticated;
revoke update on public.bookings from anon,authenticated;
revoke update(status) on public.bookings from authenticated;
grant update(status) on public.bookings to authenticated;

revoke all on function public.create_default_ticket_type() from public,anon,authenticated;
revoke all on function public.ticket_types_updated_at() from public,anon,authenticated;
revoke all on function public.guard_ticket_inventory() from public,anon,authenticated;
revoke all on function public.sync_general_admission_tier() from public,anon,authenticated;
revoke all on function public.prepare_booking() from public,anon,authenticated;
revoke all on function public.expire_event_reservations(uuid) from public,anon,authenticated;
revoke all on function public.get_event_ticket_types(uuid) from public,anon,authenticated;
revoke all on function public.create_booking(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.get_my_tickets() from public,anon,authenticated;
revoke all on function public.get_my_bookings() from public,anon,authenticated;
revoke all on function public.get_event_attendees(uuid) from public,anon,authenticated;
revoke all on function public.check_in_ticket(uuid,text) from public,anon,authenticated;
grant execute on function public.get_event_ticket_types(uuid) to anon,authenticated;
grant execute on function public.create_booking(uuid,jsonb) to authenticated;
grant execute on function public.get_my_tickets() to authenticated;
grant execute on function public.get_my_bookings() to authenticated;
grant execute on function public.get_event_attendees(uuid) to authenticated;
grant execute on function public.check_in_ticket(uuid,text) to authenticated;
grant execute on function public.create_default_ticket_type() to service_role;
grant execute on function public.expire_event_reservations(uuid) to service_role;
