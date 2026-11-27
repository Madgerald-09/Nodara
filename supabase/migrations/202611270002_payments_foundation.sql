-- Additive Paystack payment records and trusted paid-booking finalization.
-- Payment provider verification is performed by a trusted server-side function;
-- this migration does not implement checkout, webhooks, or refunds.

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete restrict,
  provider text not null default 'paystack' check (provider = 'paystack'),
  internal_reference text not null unique check (char_length(internal_reference) between 1 and 128),
  provider_reference text check (provider_reference is null or char_length(provider_reference) between 1 and 128),
  provider_transaction_id text check (provider_transaction_id is null or char_length(provider_transaction_id) between 1 and 128),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending'
    check (status in ('pending', 'successful', 'failed', 'expired', 'refunded', 'partially_refunded')),
  initialization_status text not null default 'pending'
    check (initialization_status in ('pending', 'initialized', 'failed', 'unknown')),
  checkout_url text,
  initialization_error_code text
    check (initialization_error_code is null or initialization_error_code ~ '^[A-Z0-9_]{1,64}$'),
  provider_fee_minor bigint check (provider_fee_minor is null or provider_fee_minor >= 0),
  net_amount_minor bigint check (net_amount_minor is null or net_amount_minor >= 0),
  verified_at timestamptz,
  fulfillment_status text not null default 'pending'
    check (fulfillment_status in ('pending', 'fulfilled', 'manual_review')),
  safe_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(safe_metadata) = 'object' and octet_length(safe_metadata::text) <= 8192),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_fee_not_over_amount check (provider_fee_minor is null or provider_fee_minor <= amount_minor),
  constraint payments_net_matches_fee check (
    net_amount_minor is null or provider_fee_minor is null or net_amount_minor = amount_minor - provider_fee_minor
  ),
  constraint payments_verified_fields check (
    (status not in ('successful', 'partially_refunded', 'refunded') or
      (provider_reference is not null and provider_transaction_id is not null and verified_at is not null))
  ),
  constraint payments_fulfilled_only_after_success check (
    fulfillment_status = 'pending' or status in ('successful', 'partially_refunded', 'refunded')
  ),
  constraint payments_initialization_url_consistency check (
    (initialization_status = 'initialized') = (checkout_url is not null)
  )
);
create unique index payments_provider_reference_unique
  on public.payments(provider, provider_reference) where provider_reference is not null;
create unique index payments_provider_transaction_unique
  on public.payments(provider, provider_transaction_id) where provider_transaction_id is not null;
create index payments_booking_created_idx on public.payments(booking_id, created_at desc);
create index payments_status_created_idx on public.payments(status, created_at desc);
create unique index payments_one_pending_attempt_per_booking
  on public.payments(booking_id) where status = 'pending';

create table public.payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'paystack' check (provider = 'paystack'),
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 255),
  event_type text not null check (char_length(event_type) between 1 and 128),
  processing_status text not null default 'received'
    check (processing_status in ('received', 'processing', 'processed', 'failed', 'ignored')),
  payment_id uuid references public.payments(id) on delete set null,
  received_at timestamptz not null default now(),
  processing_started_at timestamptz,
  processed_at timestamptz,
  safe_error_code text check (safe_error_code is null or safe_error_code ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_webhook_events_unique_provider_event unique(provider, provider_event_id),
  constraint payment_webhook_events_processed_timestamp check (
    (processing_status = 'processed') = (processed_at is not null)
  )
);
create index payment_webhook_events_status_received_idx
  on public.payment_webhook_events(processing_status, received_at);
create index payment_webhook_events_payment_idx on public.payment_webhook_events(payment_id);

create table public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  provider_refund_reference text check (
    provider_refund_reference is null or char_length(provider_refund_reference) between 1 and 128
  ),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'succeeded', 'failed', 'cancelled')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint payment_refunds_completion_timestamp check (
    (status in ('succeeded', 'failed', 'cancelled')) = (completed_at is not null)
  )
);
create unique index payment_refunds_provider_reference_unique
  on public.payment_refunds(provider_refund_reference) where provider_refund_reference is not null;
create index payment_refunds_payment_created_idx on public.payment_refunds(payment_id, created_at desc);

alter table public.payments enable row level security;
alter table public.payment_webhook_events enable row level security;
alter table public.payment_refunds enable row level security;

-- No browser role reads or writes trusted payment evidence. The server-side
-- service role bypasses RLS and receives only the table access needed by its APIs.
revoke all privileges on table public.payments, public.payment_webhook_events, public.payment_refunds
  from public, anon, authenticated;
grant all privileges on table public.payments, public.payment_webhook_events, public.payment_refunds
  to service_role;

create function public.payments_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger payments_set_updated_at before update on public.payments
  for each row execute function public.payments_updated_at();
create trigger payment_webhook_events_set_updated_at before update on public.payment_webhook_events
  for each row execute function public.payments_updated_at();
revoke all on function public.payments_updated_at() from public, anon, authenticated;
grant execute on function public.payments_updated_at() to service_role;

-- The existing booking trigger intentionally rejects client status/payment edits.
-- This narrow branch permits only the trusted payment finalizer to transition a
-- payment_pending booking to confirmed/verified or record a late verified payment
-- on an already expired booking. Every other protected field remains immutable.
create or replace function public.prepare_booking()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('nodara.payment_finalization', true) = 'on'
    and auth.role() = 'service_role' then
    if new.id is distinct from old.id
      or new.event_id is distinct from old.event_id
      or new.user_id is distinct from old.user_id
      or new.quantity is distinct from old.quantity
      or new.total_amount is distinct from old.total_amount
      or new.currency is distinct from old.currency
      or new.booking_reference is distinct from old.booking_reference
      or new.created_at is distinct from old.created_at
      or new.expires_at is distinct from old.expires_at
      or new.payment_provider is distinct from old.payment_provider
      or new.payment_reference is distinct from old.payment_reference
      or new.solana_network is distinct from old.solana_network
      or new.solana_transaction_signature is distinct from old.solana_transaction_signature
      or new.payment_status is distinct from 'verified'
      or not ((old.status = 'payment_pending' and new.status = 'confirmed'
          and old.payment_status = 'pending')
        or (old.status = 'expired' and new.status = 'expired'
          and old.payment_status = 'pending')) then
      raise exception 'Booking fields are protected';
    end if;
    return new;
  end if;

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
revoke all on function public.prepare_booking() from public, anon, authenticated;

-- Call only after the Paystack transaction has been independently verified by
-- trusted server code. This function never accepts a frontend success claim.
create function public.finalize_verified_payment(
  p_payment_id uuid,
  p_provider_reference text,
  p_provider_transaction_id text,
  p_amount_minor bigint,
  p_currency text,
  p_provider_fee_minor bigint default null,
  p_net_amount_minor bigint default null,
  p_verified_at timestamptz default now(),
  p_safe_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_booking public.bookings%rowtype;
  v_item record;
  v_item_count integer;
  v_ticket_count integer;
  v_quantity bigint;
  v_item_total numeric;
  v_item_currency_count integer;
  v_item_currency text;
  v_expected_minor bigint;
  v_late boolean := false;
  v_inventory_consistent boolean := true;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted payment verifier required';
  end if;
  if p_payment_id is null or p_provider_reference is null
    or char_length(p_provider_reference) not between 1 and 128
    or p_provider_transaction_id is null
    or char_length(p_provider_transaction_id) not between 1 and 128
    or p_amount_minor is null or p_amount_minor <= 0
    or p_currency is null or p_currency !~ '^[A-Z]{3}$'
    or p_verified_at is null or p_verified_at > now() + interval '5 minutes'
    or (p_provider_fee_minor is not null and p_provider_fee_minor < 0)
    or (p_net_amount_minor is not null and p_net_amount_minor < 0)
    or (p_provider_fee_minor is not null and p_provider_fee_minor > p_amount_minor)
    or (p_net_amount_minor is not null and p_provider_fee_minor is not null
      and p_net_amount_minor <> p_amount_minor - p_provider_fee_minor)
    or p_safe_metadata is null or jsonb_typeof(p_safe_metadata) <> 'object'
    or octet_length(p_safe_metadata::text) > 8192 then
    raise exception 'Verified payment evidence is invalid';
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then raise exception 'Payment was not found'; end if;
  select * into v_booking from public.bookings where id = v_payment.booking_id for update;
  if not found then raise exception 'Payment booking was not found'; end if;

  if v_payment.provider <> 'paystack' then raise exception 'Unsupported payment provider'; end if;
  if v_payment.provider_reference is distinct from p_provider_reference then
    raise exception 'Verified payment reference does not match the payment';
  end if;
  if v_payment.status = 'successful' then
    if v_payment.provider_reference = p_provider_reference
      and v_payment.provider_transaction_id = p_provider_transaction_id
      and v_payment.amount_minor = p_amount_minor and v_payment.currency = p_currency then
      return jsonb_build_object(
        'result', case when v_payment.fulfillment_status = 'manual_review'
          then 'manual_review' else 'already_finalized' end,
        'idempotent', true, 'booking_id', v_booking.id, 'payment_id', v_payment.id
      );
    end if;
    raise exception 'Payment was already finalized with different provider evidence';
  end if;
  -- A later Paystack verify response may confirm a transaction whose earlier
  -- webhook was out of order and recorded as failed. Trusted success evidence
  -- may promote that attempt; all other terminal states remain ineligible.
  if v_payment.status not in ('pending', 'failed') then raise exception 'Payment is not pending'; end if;
  if v_payment.provider_transaction_id is not null then raise exception 'Payment already has a provider transaction'; end if;
  if v_payment.amount_minor <> p_amount_minor or v_payment.currency <> p_currency
    or v_booking.currency <> p_currency then
    raise exception 'Verified payment amount or currency does not match the booking';
  end if;
  if v_booking.total_amount * 100 <> trunc(v_booking.total_amount * 100) then
    raise exception 'Booking amount cannot be represented in minor units';
  end if;
  v_expected_minor := (v_booking.total_amount * 100)::bigint;
  if v_expected_minor <> v_payment.amount_minor then
    raise exception 'Payment amount does not match the booking total';
  end if;

  select count(*)::integer, coalesce(sum(bi.quantity), 0),
    coalesce(sum(bi.unit_price * bi.quantity), 0), count(distinct bi.currency), min(bi.currency)
  into v_item_count, v_quantity, v_item_total, v_item_currency_count, v_item_currency
  from public.booking_items bi where bi.booking_id = v_booking.id;
  if v_item_count = 0 or v_quantity <> v_booking.quantity
    or v_item_total <> v_booking.total_amount or v_item_currency_count <> 1
    or v_item_currency is distinct from v_booking.currency then
    raise exception 'Booking items do not match the reserved booking';
  end if;
  if exists (
    select 1 from public.booking_items bi
    join public.ticket_types tt on tt.id = bi.ticket_type_id
    where bi.booking_id = v_booking.id and tt.event_id <> v_booking.event_id
  ) then
    raise exception 'Booking item references an inconsistent ticket type';
  end if;

  -- Expire only this locked booking. The general expiry routine sweeps every
  -- booking for an event, which is broader than a payment finalization needs.
  if v_booking.status = 'payment_pending' and v_booking.expires_at is not null
    and v_booking.expires_at <= now() then
    for v_item in
      select bi.id as booking_item_id, bi.ticket_type_id, bi.quantity, tt.quantity_reserved
      from public.booking_items bi
      join public.ticket_types tt on tt.id = bi.ticket_type_id
      where bi.booking_id = v_booking.id
      order by tt.id
      for update of tt
    loop
      if v_item.quantity_reserved < v_item.quantity then
        v_inventory_consistent := false;
      end if;
    end loop;
    if v_inventory_consistent then
      perform set_config('nodara.ticket_inventory_write', 'on', true);
      for v_item in
        select bi.ticket_type_id, bi.quantity from public.booking_items bi
        where bi.booking_id = v_booking.id order by bi.ticket_type_id
      loop
        update public.ticket_types set quantity_reserved = quantity_reserved - v_item.quantity
          where id = v_item.ticket_type_id;
      end loop;
      perform set_config('nodara.ticket_inventory_write', 'off', true);
    end if;
    update public.bookings set status = 'expired' where id = v_booking.id;
    v_booking.status := 'expired';
  end if;

  if v_booking.status = 'expired'
    or (v_booking.status = 'confirmed' and v_booking.payment_status = 'verified') then
    v_late := true;
  elsif v_booking.status <> 'payment_pending' or v_booking.payment_status <> 'pending'
    or v_booking.expires_at is null or v_booking.expires_at <= now() then
    raise exception 'Booking is not eligible for payment finalization';
  end if;

  select count(*)::integer into v_ticket_count from public.tickets t where t.booking_id = v_booking.id;
  if v_ticket_count <> 0 then raise exception 'Tickets already exist for this paid booking'; end if;

  if not v_late then
    for v_item in
      select bi.id as booking_item_id, bi.ticket_type_id, bi.quantity,
        tt.quantity_reserved, tt.quantity_sold, tt.capacity
      from public.booking_items bi
      join public.ticket_types tt on tt.id = bi.ticket_type_id
      where bi.booking_id = v_booking.id
      order by tt.id
      for update of tt
    loop
      if v_item.quantity_reserved < v_item.quantity then
        raise exception 'Reserved ticket inventory is inconsistent';
      end if;
    end loop;

    perform set_config('nodara.ticket_inventory_write', 'on', true);
    for v_item in
      select bi.id as booking_item_id, bi.ticket_type_id, bi.quantity
      from public.booking_items bi
      where bi.booking_id = v_booking.id order by bi.ticket_type_id
    loop
      update public.ticket_types
      set quantity_reserved = quantity_reserved - v_item.quantity,
          quantity_sold = quantity_sold + v_item.quantity
      where id = v_item.ticket_type_id;
      if not found then raise exception 'Reserved ticket type was not found'; end if;

      insert into public.tickets(booking_id, booking_item_id, event_id, ticket_type_id, user_id)
      select v_booking.id, v_item.booking_item_id, v_booking.event_id,
        v_item.ticket_type_id, v_booking.user_id
      from generate_series(1, v_item.quantity);
    end loop;
    perform set_config('nodara.ticket_inventory_write', 'off', true);
  end if;

  update public.payments set
    status = 'successful', provider_transaction_id = p_provider_transaction_id,
    provider_fee_minor = p_provider_fee_minor, net_amount_minor = p_net_amount_minor,
    verified_at = p_verified_at, fulfillment_status = case when v_late then 'manual_review' else 'fulfilled' end,
    safe_metadata = p_safe_metadata, updated_at = now()
  where id = v_payment.id;

  perform set_config('nodara.payment_finalization', 'on', true);
  if v_late then
    update public.bookings set payment_status = 'verified'
      where id = v_booking.id and payment_status = 'pending';
  else
    update public.bookings set status = 'confirmed', payment_status = 'verified' where id = v_booking.id;
  end if;
  perform set_config('nodara.payment_finalization', 'off', true);

  return jsonb_build_object(
    'result', case when v_late then 'manual_review' else 'finalized' end,
    'idempotent', false, 'booking_id', v_booking.id, 'payment_id', v_payment.id,
    'ticket_count', case when v_late then 0 else v_quantity end
  );
end;
$$;

revoke all on function public.finalize_verified_payment(uuid, text, text, bigint, text, bigint, bigint, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_verified_payment(uuid, text, text, bigint, text, bigint, bigint, timestamptz, jsonb)
  to service_role;

comment on table public.payments is
  'Trusted Paystack transaction records. checkout_url is service-only and returned only to the owning booking user. safe_metadata must contain curated non-secret metadata only; never store webhook bodies or credentials.';
comment on table public.payment_webhook_events is
  'Webhook idempotency and processing ledger. Raw webhook bodies and secrets are intentionally not stored.';
comment on table public.payment_refunds is
  'Trusted refund lifecycle records; provider refund calls are implemented in a later milestone.';
comment on function public.finalize_verified_payment(uuid, text, text, bigint, text, bigint, bigint, timestamptz, jsonb) is
  'Service-role-only finalization after independent Paystack verification. Late payments are recorded for manual review without issuing tickets or restoring inventory.';
