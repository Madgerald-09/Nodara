-- Serialize payment-attempt creation and checkout URL release with booking
-- expiry. Existing deployed migration files remain untouched.

create function public.create_pending_paystack_payment(
  p_booking_id uuid,
  p_user_id uuid,
  p_reference text,
  p_amount_minor bigint,
  p_currency text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
  v_payment public.payments%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted payment initializer required';
  end if;
  if p_booking_id is null or p_user_id is null or p_reference is null
    or p_reference !~ '^[A-Za-z0-9_.=-]{1,128}$'
    or p_amount_minor is null or p_amount_minor <= 0
    or p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'Payment initialization request is invalid';
  end if;

  -- The booking lock serializes this with expiry's booking lock. The expiry
  -- worker locks payments first, then the booking; this routine never locks an
  -- existing payment, so it cannot form a reverse lock cycle.
  select b.* into v_booking from public.bookings b
  where b.id = p_booking_id for update;
  if not found or v_booking.user_id <> p_user_id then
    raise exception 'Booking was not found or access was denied';
  end if;
  if v_booking.status <> 'payment_pending' or v_booking.payment_status <> 'pending'
    or v_booking.expires_at is null or v_booking.expires_at <= clock_timestamp() then
    raise exception 'Booking reservation is no longer payable';
  end if;
  if v_booking.currency <> p_currency
    or v_booking.total_amount * 100 <> trunc(v_booking.total_amount * 100)
    or (v_booking.total_amount * 100)::bigint <> p_amount_minor then
    raise exception 'Payment amount or currency does not match the booking';
  end if;

  select p.* into v_payment from public.payments p
  where p.booking_id = p_booking_id and p.status = 'pending'
  order by p.created_at desc limit 1;
  if found then
    if v_payment.amount_minor <> p_amount_minor or v_payment.currency <> p_currency then
      raise exception 'Existing payment attempt does not match the booking';
    end if;
    return jsonb_build_object(
      'id', v_payment.id,
      'internal_reference', v_payment.internal_reference,
      'provider_reference', v_payment.provider_reference,
      'amount_minor', v_payment.amount_minor,
      'currency', v_payment.currency,
      'status', v_payment.status,
      'initialization_status', v_payment.initialization_status,
      'checkout_url', v_payment.checkout_url,
      'created', false
    );
  end if;

  insert into public.payments(
    booking_id, provider, internal_reference, provider_reference,
    amount_minor, currency, status, initialization_status, safe_metadata
  ) values (
    p_booking_id, 'paystack', p_reference, p_reference,
    p_amount_minor, p_currency, 'pending', 'pending',
    '{"source":"payment_edge_function"}'::jsonb
  ) returning * into v_payment;

  return jsonb_build_object(
    'id', v_payment.id,
    'internal_reference', v_payment.internal_reference,
    'provider_reference', v_payment.provider_reference,
    'amount_minor', v_payment.amount_minor,
    'currency', v_payment.currency,
    'status', v_payment.status,
    'initialization_status', v_payment.initialization_status,
    'checkout_url', v_payment.checkout_url,
    'created', true
  );
end;
$$;

create function public.save_paystack_initialization(
  p_payment_id uuid,
  p_authorization_url text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_booking public.bookings%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted payment initializer required';
  end if;
  if p_payment_id is null or p_authorization_url is null
    or char_length(p_authorization_url) > 2048 then
    raise exception 'Paystack checkout details are invalid';
  end if;

  -- Match finalization and expiry's payment → booking lock order.
  select p.* into v_payment from public.payments p
  where p.id = p_payment_id for update;
  if not found then raise exception 'Payment attempt was not found'; end if;
  select b.* into v_booking from public.bookings b
  where b.id = v_payment.booking_id for update;
  if not found then raise exception 'Payment booking was not found'; end if;

  if v_payment.status <> 'pending' then return false; end if;
  if v_booking.status <> 'payment_pending' or v_booking.payment_status <> 'pending'
    or v_booking.expires_at is null or v_booking.expires_at <= clock_timestamp() then
    -- No checkout URL has been returned to the customer yet. Retain the
    -- provider reference for reconciliation, but prevent a stale checkout link.
    update public.payments set status = 'failed', initialization_status = 'failed',
      initialization_error_code = 'RESERVATION_EXPIRED', updated_at = now()
    where id = v_payment.id and status = 'pending';
    return false;
  end if;

  update public.payments set initialization_status = 'initialized',
    initialization_error_code = null, checkout_url = p_authorization_url,
    safe_metadata = '{"source":"payment_edge_function","initialization":"accepted"}'::jsonb,
    updated_at = now()
  where id = v_payment.id and status = 'pending';
  return found;
end;
$$;

revoke all on function public.create_pending_paystack_payment(uuid,uuid,text,bigint,text)
  from public, anon, authenticated;
revoke all on function public.save_paystack_initialization(uuid,text)
  from public, anon, authenticated;
grant execute on function public.create_pending_paystack_payment(uuid,uuid,text,bigint,text)
  to service_role;
grant execute on function public.save_paystack_initialization(uuid,text)
  to service_role;

comment on function public.create_pending_paystack_payment(uuid,uuid,text,bigint,text) is
  'Service-only idempotent payment-attempt creation. Locks and revalidates the booking so expiry cannot race a stale attempt into existence.';
comment on function public.save_paystack_initialization(uuid,text) is
  'Service-only checkout URL persistence. Uses payment→booking locks and refuses to release checkout after reservation expiry.';
