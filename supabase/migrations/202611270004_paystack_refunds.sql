-- Paystack refund lifecycle. Refunds are scoped to specific, still-usable tickets
-- so a partial refund never cancels unrelated tickets in the booking.

alter table public.payment_refunds
  add column refund_reference text,
  add column provider_refund_id text,
  add column requested_by uuid references public.profiles(id) on delete set null,
  add column request_key uuid,
  add column safe_error_code text,
  add column updated_at timestamptz not null default now();

update public.payment_refunds
set refund_reference = 'legacy_' || replace(id::text, '-', ''),
    request_key = id;

alter table public.payment_refunds
  alter column refund_reference set not null,
  alter column request_key set not null,
  add constraint payment_refunds_reference_format
    check (refund_reference ~ '^[A-Za-z0-9_-]{8,64}$'),
  add constraint payment_refunds_provider_id_format
    check (provider_refund_id is null or provider_refund_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  add constraint payment_refunds_safe_error_code
    check (safe_error_code is null or safe_error_code ~ '^[A-Z0-9_]{1,64}$');

create unique index payment_refunds_internal_reference_unique
  on public.payment_refunds(refund_reference);
create unique index payment_refunds_request_key_unique
  on public.payment_refunds(request_key);
create unique index payment_refunds_provider_id_unique
  on public.payment_refunds(provider_refund_id) where provider_refund_id is not null;
create index payment_refunds_status_payment_idx
  on public.payment_refunds(payment_id, status, created_at);

create table public.payment_refund_items (
  id uuid primary key default gen_random_uuid(),
  refund_id uuid not null references public.payment_refunds(id) on delete restrict,
  ticket_id uuid not null references public.tickets(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  unique (refund_id, ticket_id)
);
create index payment_refund_items_ticket_idx on public.payment_refund_items(ticket_id, created_at desc);
create index payment_refund_items_refund_idx on public.payment_refund_items(refund_id);

create function public.get_event_attendee_refunds(p_event_id uuid)
returns table(ticket_id uuid, amount_minor bigint, currency text, status text,
  requested_at timestamptz, completed_at timestamptz, safe_error_code text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists(
    select 1 from public.events e where e.id=p_event_id and e.organizer_id=auth.uid()
  ) then raise exception 'Event not found or access denied'; end if;
  return query
    select i.ticket_id, i.amount_minor, i.currency, r.status, r.created_at, r.completed_at, r.safe_error_code
    from public.payment_refund_items i
    join public.payment_refunds r on r.id=i.refund_id
    join public.tickets t on t.id=i.ticket_id
    where t.event_id=p_event_id
    order by r.created_at desc;
end;
$$;
revoke all on function public.get_event_attendee_refunds(uuid) from public, anon, authenticated;
grant execute on function public.get_event_attendee_refunds(uuid) to authenticated;

create function public.guard_ticket_refund_reservation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'issued' and new.status = 'checked_in'
    and exists (
      select 1 from public.payment_refund_items i
      join public.payment_refunds r on r.id = i.refund_id
      where i.ticket_id = old.id and r.status in ('pending', 'processing')
    ) then
    raise exception 'Ticket is reserved for a pending refund';
  end if;
  return new;
end;
$$;
create trigger tickets_guard_refund_reservation before update of status on public.tickets
  for each row execute function public.guard_ticket_refund_reservation();
revoke all on function public.guard_ticket_refund_reservation() from public, anon, authenticated;

alter table public.payment_refund_items enable row level security;
revoke all privileges on table public.payment_refund_items from public, anon, authenticated;
grant all privileges on table public.payment_refund_items to service_role;
revoke all privileges on table public.payment_refunds from public, anon, authenticated;
grant all privileges on table public.payment_refunds to service_role;

-- The amount is computed from immutable booking item prices and the selected
-- ticket IDs. A payment row lock serializes overlapping requests and reserves
-- refundable balance before a provider call is made.
create function public.request_paystack_refund(
  p_payment_id uuid,
  p_requester_id uuid,
  p_request_key uuid,
  p_ticket_ids uuid[]
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_payment public.payments%rowtype;
  v_booking public.bookings%rowtype;
  v_event public.events%rowtype;
  v_refund public.payment_refunds%rowtype;
  v_amount bigint := 0;
  v_count integer := 0;
  v_ticket record;
  v_existing numeric;
  v_requester_is_owner boolean;
  v_requester_is_organizer boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted refund service required';
  end if;
  if p_payment_id is null or p_requester_id is null or p_request_key is null
    or p_ticket_ids is null or cardinality(p_ticket_ids) < 1 or cardinality(p_ticket_ids) > 20 then
    raise exception 'Refund request is invalid';
  end if;
  if cardinality(p_ticket_ids) <> (select count(distinct u.ticket_id)::integer from unnest(p_ticket_ids) as u(ticket_id)) then
    raise exception 'Refund ticket list contains duplicates';
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then raise exception 'Payment was not found'; end if;
  select * into v_booking from public.bookings where id = v_payment.booking_id for update;
  if not found then raise exception 'Booking was not found'; end if;

  select * into v_refund from public.payment_refunds where request_key = p_request_key;
  if found then
    if v_refund.payment_id <> v_payment.id or v_refund.requested_by is distinct from p_requester_id then
      raise exception 'Refund idempotency key is already in use';
    end if;
    if (select array_agg(i.ticket_id order by i.ticket_id) from public.payment_refund_items i where i.refund_id=v_refund.id)
      is distinct from (select array_agg(u.ticket_id order by u.ticket_id) from unnest(p_ticket_ids) as u(ticket_id)) then
      raise exception 'Refund idempotency key was reused for a different ticket selection';
    end if;
    return jsonb_build_object('refund_id', v_refund.id, 'refund_reference', v_refund.refund_reference,
      'amount_minor', v_refund.amount_minor, 'currency', v_refund.currency,
      'status', v_refund.status, 'idempotent', true);
  end if;

  if v_payment.provider <> 'paystack' or v_payment.status not in ('successful', 'partially_refunded')
    or v_payment.fulfillment_status <> 'fulfilled' or v_booking.status <> 'confirmed'
    or v_booking.payment_status <> 'verified' then
    raise exception 'Booking payment is not eligible for a refund';
  end if;

  select * into v_event from public.events where id = v_booking.event_id;
  v_requester_is_owner := v_booking.user_id = p_requester_id;
  v_requester_is_organizer := v_event.organizer_id = p_requester_id;
  if not v_requester_is_owner and not v_requester_is_organizer then
    raise exception 'Refund request access denied';
  end if;

  -- Lock in stable order after payment and booking, matching other financial RPCs.
  perform t.id from public.tickets t
    where t.id = any(p_ticket_ids) and t.booking_id = v_booking.id
    order by t.id for update;
  for v_ticket in
    select t.id, t.event_id, t.status, t.blockchain_status, t.holder_user_id, t.ticket_type_id,
      tt.event_id as ticket_event_id, bi.unit_price, bi.currency
    from public.tickets t
    join public.booking_items bi on bi.id = t.booking_item_id
    join public.ticket_types tt on tt.id = t.ticket_type_id
    where t.id = any(p_ticket_ids) and t.booking_id = v_booking.id
    order by t.id
  loop
    v_count := v_count + 1;
    if v_ticket.event_id <> v_booking.event_id or v_ticket.ticket_event_id <> v_booking.event_id then
      raise exception 'Ticket event does not match its booking';
    end if;
    if v_ticket.status <> 'issued' then raise exception 'Checked-in or cancelled tickets cannot be refunded'; end if;
    if v_ticket.blockchain_status <> 'off_chain' then
      raise exception 'On-chain tickets require verified organiser invalidation before refund';
    end if;
    if exists (select 1 from public.ticket_checkin_history h where h.ticket_id = v_ticket.id)
      or exists (select 1 from public.ticket_transfer_history h where h.ticket_id = v_ticket.id) then
      raise exception 'Checked-in or transferred tickets cannot be refunded';
    end if;
    if v_requester_is_owner and v_ticket.holder_user_id is distinct from p_requester_id then
      raise exception 'Only the current ticket holder may request this refund';
    end if;
    if v_ticket.currency <> v_payment.currency or v_ticket.unit_price * 100 <> trunc(v_ticket.unit_price * 100)
      or (v_ticket.currency = 'XOF' and v_ticket.unit_price <> trunc(v_ticket.unit_price)) then
      raise exception 'Ticket price or currency cannot be represented as a Paystack refund';
    end if;
    v_amount := v_amount + (v_ticket.unit_price * 100)::bigint;
  end loop;
  if v_count <> cardinality(p_ticket_ids) then raise exception 'One or more tickets are not in this booking'; end if;
  if v_amount <= 0 then raise exception 'Refund amount must be positive'; end if;

  if exists (
    select 1 from public.payment_refund_items i
    join public.payment_refunds r on r.id = i.refund_id
    where i.ticket_id = any(p_ticket_ids) and r.status in ('pending', 'processing', 'succeeded')
  ) then raise exception 'One or more tickets already have an active or completed refund'; end if;

  select coalesce(sum(amount_minor), 0) into v_existing from public.payment_refunds
    where payment_id = v_payment.id and status in ('pending', 'processing', 'succeeded');
  if v_existing + v_amount > v_payment.amount_minor then raise exception 'Refund exceeds remaining refundable balance'; end if;

  insert into public.payment_refunds(payment_id, refund_reference, amount_minor, currency, status, requested_by, request_key)
  values(v_payment.id, 'rf_' || replace(gen_random_uuid()::text, '-', ''), v_amount, v_payment.currency,
    'pending', p_requester_id, p_request_key)
  returning * into v_refund;
  insert into public.payment_refund_items(refund_id, ticket_id, amount_minor, currency)
    select v_refund.id, t.id, (bi.unit_price * 100)::bigint, bi.currency
    from public.tickets t join public.booking_items bi on bi.id = t.booking_item_id
    where t.id = any(p_ticket_ids) order by t.id;

  return jsonb_build_object('refund_id', v_refund.id, 'refund_reference', v_refund.refund_reference,
    'amount_minor', v_refund.amount_minor, 'currency', v_refund.currency,
    'status', v_refund.status, 'provider_transaction_id', v_payment.provider_transaction_id,
    'idempotent', false);
end;
$$;

create function public.record_paystack_refund_initiation(
  p_refund_id uuid, p_refund_reference text, p_provider_refund_id text, p_transaction_id text,
  p_amount_minor bigint, p_currency text, p_provider_status text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_refund public.payment_refunds%rowtype; v_payment public.payments%rowtype; v_status text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Trusted refund service required'; end if;
  if p_refund_reference is null or p_provider_refund_id is null or p_transaction_id is null or p_amount_minor is null
    or p_currency is null or p_provider_status not in ('pending', 'processing', 'needs-attention', 'processed', 'failed') then
    raise exception 'Provider refund evidence is invalid';
  end if;
  select p.* into v_payment from public.payments p join public.payment_refunds r on r.payment_id=p.id
    where r.id=p_refund_id for update of p;
  if not found then raise exception 'Refund request was not found'; end if;
  select * into v_refund from public.payment_refunds where id=p_refund_id for update;
  if v_refund.refund_reference <> p_refund_reference
    or v_refund.amount_minor <> p_amount_minor or v_refund.currency <> p_currency then
    raise exception 'Provider refund does not match the request';
  end if;
  if v_payment.provider_transaction_id is distinct from p_transaction_id then
    raise exception 'Provider refund transaction does not match the payment';
  end if;
  if v_refund.provider_refund_id is not null and v_refund.provider_refund_id <> p_provider_refund_id then
    raise exception 'Provider refund ID changed';
  end if;
  if v_refund.status in ('succeeded','failed','cancelled') then
    return jsonb_build_object('refund_id',v_refund.id,'status',v_refund.status,'idempotent',true);
  end if;
  v_status := case when p_provider_status = 'processed' then 'processing'
    when p_provider_status = 'failed' then 'failed' else 'processing' end;
  update public.payment_refunds set provider_refund_reference=p_refund_reference,
    provider_refund_id=p_provider_refund_id, status=v_status,
    completed_at=case when v_status='failed' then now() else null end,
    safe_error_code=case when p_provider_status='needs-attention' then 'PROVIDER_NEEDS_ATTENTION' else null end,
    updated_at=now() where id=v_refund.id;
  return jsonb_build_object('refund_id',v_refund.id,'status',v_status);
end;
$$;

create function public.fail_unsubmitted_paystack_refund(p_refund_id uuid, p_error_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Trusted refund service required'; end if;
  if p_error_code is null or p_error_code !~ '^[A-Z0-9_]{1,64}$' then
    raise exception 'Safe refund error code is invalid';
  end if;
  update public.payment_refunds set status='failed', completed_at=now(),
    safe_error_code=p_error_code, updated_at=now()
    where id=p_refund_id and status='pending' and provider_refund_id is null;
  if not found then raise exception 'Refund request was already submitted or changed'; end if;
end;
$$;

-- Call only after GET /refund (or a signed webhook followed by GET /refund)
-- confirms reference, transaction, amount, currency and provider status.
create function public.finalize_verified_paystack_refund(
  p_refund_id uuid, p_refund_reference text, p_provider_refund_id text,
  p_transaction_reference text, p_amount_minor bigint, p_currency text,
  p_provider_status text, p_verified_at timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_payment public.payments%rowtype;
  v_refund public.payment_refunds%rowtype;
  v_total bigint;
  v_status text;
  v_ticket_id uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Trusted refund verifier required'; end if;
  if p_refund_id is null or p_refund_reference is null or p_provider_refund_id is null
    or p_transaction_reference is null or p_amount_minor is null or p_amount_minor <= 0
    or p_currency is null or p_currency !~ '^[A-Z]{3}$'
    or p_provider_status not in ('pending','processing','needs-attention','processed','failed')
    or p_verified_at is null or p_verified_at > now() + interval '5 minutes' then
    raise exception 'Verified provider refund evidence is invalid';
  end if;

  select p.* into v_payment from public.payments p join public.payment_refunds r on r.payment_id=p.id
    where r.id=p_refund_id for update of p;
  if not found then raise exception 'Payment was not found'; end if;
  select * into v_refund from public.payment_refunds where id=p_refund_id for update;
  if v_refund.refund_reference <> p_refund_reference or v_refund.amount_minor <> p_amount_minor
    or v_refund.currency <> p_currency or v_payment.currency <> p_currency
    or v_payment.provider_reference is distinct from p_transaction_reference
    or v_payment.provider_transaction_id is null then
    raise exception 'Verified refund does not match the stored payment';
  end if;
  if v_refund.provider_refund_id is not null and v_refund.provider_refund_id <> p_provider_refund_id then
    raise exception 'Provider refund ID changed';
  end if;
  if v_refund.status='succeeded' and p_provider_status='processed' then
    return jsonb_build_object('status','succeeded','idempotent',true);
  end if;

  v_status := case when p_provider_status='processed' then 'succeeded'
    when p_provider_status='failed' then 'failed' else 'processing' end;
  if v_refund.status='succeeded' and v_status <> 'succeeded' then
    return jsonb_build_object('status','succeeded','idempotent',true);
  end if;
  if v_refund.status='failed' and v_status='processing' then
    return jsonb_build_object('status','failed','idempotent',true);
  end if;

  update public.payment_refunds set provider_refund_reference=p_refund_reference,
    provider_refund_id=p_provider_refund_id, status=v_status,
    completed_at=case when v_status in ('succeeded','failed') then p_verified_at else null end,
    safe_error_code=case when p_provider_status='needs-attention' then 'PROVIDER_NEEDS_ATTENTION' else null end,
    updated_at=now() where id=p_refund_id;

  if v_status='succeeded' then
    for v_ticket_id in select i.ticket_id from public.payment_refund_items i
      where i.refund_id=p_refund_id order by i.ticket_id
    loop
      perform 1 from public.tickets t where t.id=v_ticket_id for update;
      if not found then raise exception 'Refund ticket is no longer available'; end if;
      if exists(select 1 from public.ticket_checkin_history h where h.ticket_id=v_ticket_id)
        or exists(select 1 from public.ticket_transfer_history h where h.ticket_id=v_ticket_id) then
        raise exception 'Ticket was checked in or transferred before refund completion';
      end if;
      update public.tickets set status='cancelled' where id=v_ticket_id and status='issued'
        and blockchain_status='off_chain';
      if not found then raise exception 'Ticket cannot be cancelled for this refund'; end if;
    end loop;
    select coalesce(sum(r.amount_minor),0)::bigint into v_total from public.payment_refunds r
      where r.payment_id=v_payment.id and r.status='succeeded';
    update public.payments set status=case when v_total >= v_payment.amount_minor then 'refunded' else 'partially_refunded' end,
      updated_at=now() where id=v_payment.id;
  end if;
  return jsonb_build_object('status',v_status,'idempotent',false);
end;
$$;

revoke all on function public.request_paystack_refund(uuid,uuid,uuid,uuid[]) from public, anon, authenticated;
revoke all on function public.record_paystack_refund_initiation(uuid,text,text,text,bigint,text,text) from public, anon, authenticated;
revoke all on function public.fail_unsubmitted_paystack_refund(uuid,text) from public, anon, authenticated;
revoke all on function public.finalize_verified_paystack_refund(uuid,text,text,text,bigint,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.request_paystack_refund(uuid,uuid,uuid,uuid[]) to service_role;
grant execute on function public.record_paystack_refund_initiation(uuid,text,text,text,bigint,text,text) to service_role;
grant execute on function public.fail_unsubmitted_paystack_refund(uuid,text) to service_role;
grant execute on function public.finalize_verified_paystack_refund(uuid,text,text,text,bigint,text,text,timestamptz) to service_role;

comment on table public.payment_refund_items is
  'Immutable per-ticket refund entitlement snapshots. Only trusted refund RPCs can write rows.';
comment on function public.request_paystack_refund(uuid,uuid,uuid,uuid[]) is
  'Service-only refund reservation. Computes amount from ticket price snapshots, rejects checked-in/transferred/on-chain tickets, and serializes balance by locking the payment.';
comment on function public.finalize_verified_paystack_refund(uuid,text,text,text,bigint,text,text,timestamptz) is
  'Service-only synchronization after independent Paystack refund verification. Cancels only the ticket IDs in a successful refund.';
