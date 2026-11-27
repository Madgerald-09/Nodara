-- Automated cleanup for unpaid ticket reservations. This migration is additive:
-- it preserves the existing booking and payment finalization workflows.

create index if not exists bookings_payment_expiry_due_idx
  on public.bookings(expires_at, id)
  where status = 'payment_pending' and expires_at is not null;

create table public.booking_reservation_expiry_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  processing_status text not null default 'running'
    check (processing_status in ('running', 'succeeded', 'partial')),
  examined_count integer not null default 0 check (examined_count >= 0),
  expired_booking_count integer not null default 0 check (expired_booking_count >= 0),
  released_ticket_count integer not null default 0 check (released_ticket_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  safe_error_code text check (safe_error_code is null or safe_error_code ~ '^[0-9A-Z]{5}$'),
  constraint booking_expiry_runs_finished_state check (
    (processing_status = 'running' and finished_at is null)
    or (processing_status <> 'running' and finished_at is not null)
  )
);

create index booking_reservation_expiry_runs_started_idx
  on public.booking_reservation_expiry_runs(started_at desc);

create table public.booking_reservation_expiry_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.booking_reservation_expiry_runs(id) on delete cascade,
  booking_id uuid references public.bookings(id) on delete set null,
  outcome text not null check (outcome in (
    'expired', 'skipped_payment_lock', 'skipped_successful_payment',
    'skipped_booking_changed', 'inventory_inconsistent', 'processing_error'
  )),
  released_ticket_count integer not null default 0 check (released_ticket_count >= 0),
  safe_error_code text check (safe_error_code is null or safe_error_code ~ '^[0-9A-Z]{5}$'),
  processed_at timestamptz not null default clock_timestamp(),
  unique (run_id, booking_id)
);

create index booking_reservation_expiry_items_booking_idx
  on public.booking_reservation_expiry_items(booking_id, processed_at desc);

alter table public.booking_reservation_expiry_runs enable row level security;
alter table public.booking_reservation_expiry_items enable row level security;
revoke all privileges on table public.booking_reservation_expiry_runs,
  public.booking_reservation_expiry_items from public, anon, authenticated;
grant select on table public.booking_reservation_expiry_runs,
  public.booking_reservation_expiry_items to service_role;

create or replace function public.expire_expired_payment_reservations(p_batch_size integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id uuid;
  v_now timestamptz := clock_timestamp();
  v_candidate record;
  v_payment record;
  v_booking public.bookings%rowtype;
  v_item record;
  v_total_payments integer;
  v_locked_payments integer;
  v_successful_payment boolean;
  v_type_count integer;
  v_locked_type_count integer;
  v_item_quantity integer;
  v_inventory_consistent boolean;
  v_released integer;
  v_examined integer := 0;
  v_expired integer := 0;
  v_released_total integer := 0;
  v_skipped integer := 0;
  v_errors integer := 0;
  v_sqlstate text;
begin
  -- PostgREST callers must have a signed service_role JWT. Cron and the SQL
  -- migration owner run without an auth JWT and are separately constrained by
  -- EXECUTE grants to postgres/supabase_admin.
  if auth.role() is distinct from 'service_role'
    and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'Trusted reservation expiry runner required';
  end if;
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 2000 then
    raise exception 'Expiry batch size must be between 1 and 2000';
  end if;

  insert into public.booking_reservation_expiry_runs default values returning id into v_run_id;

  for v_candidate in
    select b.id
    from public.bookings b
    where b.status = 'payment_pending' and b.expires_at is not null and b.expires_at <= v_now
    order by b.expires_at, b.id
    limit p_batch_size
  loop
    v_examined := v_examined + 1;
    v_total_payments := 0;
    v_locked_payments := 0;
    v_successful_payment := false;
    begin
      -- Match finalize_verified_payment's lock order: payment rows first,
      -- booking second, then ticket types in stable ID order.
      select count(*)::integer into v_total_payments
      from public.payments p where p.booking_id = v_candidate.id;
      for v_payment in
        select p.id, p.status from public.payments p
        where p.booking_id = v_candidate.id
        order by p.id
        for update skip locked
      loop
        v_locked_payments := v_locked_payments + 1;
        if v_payment.status = 'successful' then v_successful_payment := true; end if;
      end loop;

      if v_locked_payments <> v_total_payments then
        insert into public.booking_reservation_expiry_items(run_id, booking_id, outcome)
        values (v_run_id, v_candidate.id, 'skipped_payment_lock');
        v_skipped := v_skipped + 1;
        continue;
      end if;
      if v_successful_payment then
        insert into public.booking_reservation_expiry_items(run_id, booking_id, outcome)
        values (v_run_id, v_candidate.id, 'skipped_successful_payment');
        v_skipped := v_skipped + 1;
        continue;
      end if;

      select b.* into v_booking from public.bookings b
      where b.id = v_candidate.id and b.status = 'payment_pending'
        and b.expires_at is not null and b.expires_at <= v_now
      for update skip locked;
      if not found then
        insert into public.booking_reservation_expiry_items(run_id, booking_id, outcome)
        values (v_run_id, v_candidate.id, 'skipped_booking_changed');
        v_skipped := v_skipped + 1;
        continue;
      end if;

      select count(distinct bi.ticket_type_id)::integer into v_type_count
      from public.booking_items bi where bi.booking_id = v_booking.id;
      select coalesce(sum(bi.quantity), 0)::integer into v_item_quantity
      from public.booking_items bi where bi.booking_id = v_booking.id;
      v_locked_type_count := 0;
      v_inventory_consistent := true;
      for v_item in
        select tt.id, tt.quantity_reserved, reserved.quantity
        from public.ticket_types tt
        join (
          select bi.ticket_type_id, sum(bi.quantity)::integer as quantity
          from public.booking_items bi where bi.booking_id = v_booking.id
          group by bi.ticket_type_id
        ) reserved on reserved.ticket_type_id = tt.id
        order by tt.id
        for update of tt
      loop
        v_locked_type_count := v_locked_type_count + 1;
        if v_item.quantity_reserved < v_item.quantity then
          v_inventory_consistent := false;
        end if;
      end loop;
      if v_type_count = 0 or v_locked_type_count <> v_type_count
        or v_item_quantity <> v_booking.quantity or not v_inventory_consistent then
        insert into public.booking_reservation_expiry_items(run_id, booking_id, outcome, safe_error_code)
        values (v_run_id, v_candidate.id, 'inventory_inconsistent', '23514');
        v_errors := v_errors + 1;
        continue;
      end if;

      v_released := v_item_quantity;
      perform set_config('nodara.ticket_inventory_write', 'on', true);
      for v_item in
        select bi.ticket_type_id, sum(bi.quantity)::integer as quantity
        from public.booking_items bi where bi.booking_id = v_booking.id
        group by bi.ticket_type_id order by bi.ticket_type_id
      loop
        update public.ticket_types tt
        set quantity_reserved = tt.quantity_reserved - v_item.quantity
        where tt.id = v_item.ticket_type_id;
      end loop;
      perform set_config('nodara.ticket_inventory_write', 'off', true);

      update public.bookings b set status = 'expired' where b.id = v_booking.id;
      insert into public.booking_reservation_expiry_items(run_id, booking_id, outcome, released_ticket_count)
      values (v_run_id, v_booking.id, 'expired', v_released);
      v_expired := v_expired + 1;
      v_released_total := v_released_total + v_released;
    exception when others then
      get stacked diagnostics v_sqlstate = returned_sqlstate;
      insert into public.booking_reservation_expiry_items(run_id, booking_id, outcome, safe_error_code)
      values (v_run_id, v_candidate.id, 'processing_error', v_sqlstate);
      v_errors := v_errors + 1;
    end;
  end loop;

  update public.booking_reservation_expiry_runs r set
    finished_at = clock_timestamp(),
    processing_status = case when v_errors = 0 then 'succeeded' else 'partial' end,
    examined_count = v_examined,
    expired_booking_count = v_expired,
    released_ticket_count = v_released_total,
    skipped_count = v_skipped,
    error_count = v_errors,
    safe_error_code = case when v_errors > 0 then 'PARTI' else null end
  where r.id = v_run_id;

  return jsonb_build_object(
    'run_id', v_run_id,
    'examined_count', v_examined,
    'expired_booking_count', v_expired,
    'released_ticket_count', v_released_total,
    'skipped_count', v_skipped,
    'error_count', v_errors
  );
end;
$$;

revoke all on function public.expire_expired_payment_reservations(integer)
  from public, anon, authenticated;
grant execute on function public.expire_expired_payment_reservations(integer)
  to service_role, postgres, supabase_admin;

comment on function public.expire_expired_payment_reservations(integer) is
  'Service-role/Cron-only batch expiry for payment_pending reservations. Uses payment→booking→ticket-type locks and exact-once inventory release; late payment verification remains the finalizer manual-review path.';

-- Supabase Cron is optional and enabled per project. When pg_cron is already
-- enabled, install/update one named one-minute job. Otherwise the function is
-- ready and the operator can enable Cron and create the job after migration.
do $$
begin
  if pg_catalog.to_regnamespace('cron') is null
    or pg_catalog.to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron is not enabled; schedule nodara-expire-payment-reservations after enabling Supabase Cron.';
  else
    execute 'select cron.schedule($1, $2, $3)'
      using 'nodara-expire-payment-reservations', '* * * * *',
        'select public.expire_expired_payment_reservations(500);';
  end if;
end;
$$;
