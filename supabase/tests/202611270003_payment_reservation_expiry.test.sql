begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(33);

select ok((select relrowsecurity from pg_class where oid='public.booking_reservation_expiry_runs'::regclass),
  'expiry run audit has RLS enabled');
select ok((select relrowsecurity from pg_class where oid='public.booking_reservation_expiry_items'::regclass),
  'expiry item audit has RLS enabled');
select ok(not has_function_privilege('anon',
  'public.expire_expired_payment_reservations(integer)', 'EXECUTE'),
  'anonymous callers cannot run the expiry process');
select ok(not has_function_privilege('authenticated',
  'public.expire_expired_payment_reservations(integer)', 'EXECUTE'),
  'authenticated callers cannot run the expiry process');
select ok(not has_table_privilege('anon', 'public.booking_reservation_expiry_runs', 'SELECT'),
  'anonymous callers cannot read expiry run logs');
select ok(not has_table_privilege('authenticated', 'public.booking_reservation_expiry_items', 'SELECT'),
  'authenticated callers cannot read per-booking expiry logs');
select ok(has_function_privilege('service_role',
  'public.expire_expired_payment_reservations(integer)', 'EXECUTE'),
  'trusted server role can run the expiry process');
select is((select prosecdef from pg_proc where oid='public.expire_expired_payment_reservations(integer)'::regprocedure),
  true, 'expiry function uses SECURITY DEFINER');
select like(pg_get_functiondef('public.expire_expired_payment_reservations(integer)'::regprocedure),
  $pattern$%SET search_path TO ''%$pattern$, 'expiry function pins an empty search_path');
select ok(to_regclass('public.bookings_payment_expiry_due_idx') is not null,
  'expired booking scan has a partial index');

create temporary table expiry_test_ids(
  label text primary key, booking_id uuid not null, payment_id uuid,
  event_id uuid not null, general_type_id uuid not null, second_type_id uuid
);
create temporary table expiry_test_actor(id uuid primary key);

do $$
declare
  v_actor uuid := gen_random_uuid();
  v_event uuid;
  v_general uuid;
  v_second uuid;
  v_booking uuid;
  v_payment uuid;
  v_item uuid;
begin
  insert into expiry_test_actor values(v_actor);
  insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,
    raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  values(v_actor,'authenticated','authenticated',v_actor::text || '@expiry-test.invalid','',now(),'{}','{}',now(),now());

  -- One expired booking containing two ticket types and a pending Paystack attempt.
  insert into public.events(organizer_id,title,slug,description,category,location,country,start_date,status,price,currency,capacity)
  values(v_actor,'Expiry multi type','expiry-multi-' || replace(gen_random_uuid()::text,'-',''),
    'Expiry test','Testing','Test City','Test Country',now()+interval '2 days','published',20,'USD',100)
  returning id into v_event;
  select id into v_general from public.ticket_types where event_id=v_event and name='General Admission';
  insert into public.ticket_types(event_id,name,price,currency,capacity)
  values(v_event,'Balcony',10,'USD',100) returning id into v_second;
  insert into public.bookings(event_id,user_id,quantity,total_amount,currency,status,payment_status,expires_at)
  values(v_event,v_actor,3,40,'USD','payment_pending','pending',now()-interval '2 minutes') returning id into v_booking;
  insert into public.booking_items(booking_id,ticket_type_id,quantity,unit_price,currency)
  values(v_booking,v_general,1,20,'USD'),(v_booking,v_second,2,10,'USD');
  perform set_config('nodara.ticket_inventory_write','on',true);
  update public.ticket_types set quantity_reserved=1 where id=v_general;
  update public.ticket_types set quantity_reserved=2 where id=v_second;
  perform set_config('nodara.ticket_inventory_write','off',true);
  insert into public.payments(booking_id,internal_reference,provider_reference,amount_minor,currency)
  values(v_booking,'expiry-int-' || replace(gen_random_uuid()::text,'-',''),
    'expiry-provider-' || replace(gen_random_uuid()::text,'-',''),4000,'USD') returning id into v_payment;
  insert into expiry_test_ids values('multi',v_booking,v_payment,v_event,v_general,v_second);

  -- Confirmed bookings are ineligible even when an old expiry timestamp remains.
  insert into public.events(organizer_id,title,slug,description,category,location,country,start_date,status,price,currency,capacity)
  values(v_actor,'Expiry confirmed','expiry-confirmed-' || replace(gen_random_uuid()::text,'-',''),
    'Expiry test','Testing','Test City','Test Country',now()+interval '2 days','published',20,'USD',100)
  returning id into v_event;
  select id into v_general from public.ticket_types where event_id=v_event and name='General Admission';
  insert into public.bookings(event_id,user_id,quantity,total_amount,currency,status,payment_status,expires_at)
  values(v_event,v_actor,1,20,'USD','confirmed','verified',now()-interval '1 day') returning id into v_booking;
  insert into public.booking_items(booking_id,ticket_type_id,quantity,unit_price,currency)
  values(v_booking,v_general,1,20,'USD');
  insert into public.payments(booking_id,internal_reference,provider_reference,
    provider_transaction_id,amount_minor,currency,status,verified_at,fulfillment_status)
  values(v_booking,'expiry-paid-int-' || replace(gen_random_uuid()::text,'-',''),
    'expiry-paid-provider-' || replace(gen_random_uuid()::text,'-',''),
    'expiry-paid-txn-' || replace(gen_random_uuid()::text,'-',''),2000,'USD','successful',now(),'fulfilled');
  perform set_config('nodara.ticket_inventory_write','on',true);
  update public.ticket_types set quantity_sold=1 where id=v_general;
  perform set_config('nodara.ticket_inventory_write','off',true);
  insert into expiry_test_ids values('confirmed',v_booking,null,v_event,v_general,null);

  -- An already expired booking must not be counted or released a second time.
  insert into public.events(organizer_id,title,slug,description,category,location,country,start_date,status,price,currency,capacity)
  values(v_actor,'Expiry already expired','expiry-old-' || replace(gen_random_uuid()::text,'-',''),
    'Expiry test','Testing','Test City','Test Country',now()+interval '2 days','published',20,'USD',100)
  returning id into v_event;
  select id into v_general from public.ticket_types where event_id=v_event and name='General Admission';
  insert into public.bookings(event_id,user_id,quantity,total_amount,currency,status,payment_status,expires_at)
  values(v_event,v_actor,1,20,'USD','expired','pending',now()-interval '1 day') returning id into v_booking;
  insert into public.booking_items(booking_id,ticket_type_id,quantity,unit_price,currency)
  values(v_booking,v_general,1,20,'USD');
  insert into expiry_test_ids values('expired',v_booking,null,v_event,v_general,null);

  -- Separate late-payment fixture confirms finalization becomes manual review.
  insert into public.events(organizer_id,title,slug,description,category,location,country,start_date,status,price,currency,capacity)
  values(v_actor,'Expiry late payment','expiry-late-' || replace(gen_random_uuid()::text,'-',''),
    'Expiry test','Testing','Test City','Test Country',now()+interval '2 days','published',20,'USD',100)
  returning id into v_event;
  select id into v_general from public.ticket_types where event_id=v_event and name='General Admission';
  insert into public.bookings(event_id,user_id,quantity,total_amount,currency,status,payment_status,expires_at)
  values(v_event,v_actor,1,20,'USD','payment_pending','pending',now()-interval '2 minutes') returning id into v_booking;
  insert into public.booking_items(booking_id,ticket_type_id,quantity,unit_price,currency)
  values(v_booking,v_general,1,20,'USD');
  perform set_config('nodara.ticket_inventory_write','on',true);
  update public.ticket_types set quantity_reserved=1 where id=v_general;
  perform set_config('nodara.ticket_inventory_write','off',true);
  insert into public.payments(booking_id,internal_reference,provider_reference,amount_minor,currency)
  values(v_booking,'expiry-late-int-' || replace(gen_random_uuid()::text,'-',''),
    'expiry-late-provider-' || replace(gen_random_uuid()::text,'-',''),2000,'USD') returning id into v_payment;
  insert into expiry_test_ids values('late',v_booking,v_payment,v_event,v_general,null);
end;
$$;

select set_config('request.jwt.claim.role','service_role',true);
select lives_ok($test$select public.expire_expired_payment_reservations(500)$test$,
  'trusted expiry process completes a batch');
select is((select status from public.bookings where id=(select booking_id from expiry_test_ids where label='multi')),
  'expired'::text, 'overdue unpaid booking is expired');
select is((select quantity_reserved from public.ticket_types where id=(select general_type_id from expiry_test_ids where label='multi')),
  0, 'first ticket type reservation is released');
select is((select quantity_reserved from public.ticket_types where id=(select second_type_id from expiry_test_ids where label='multi')),
  0, 'second ticket type reservation is released');
select is((select released_ticket_count from public.booking_reservation_expiry_items
  where booking_id=(select booking_id from expiry_test_ids where label='multi') and outcome='expired'),
  3, 'multi-type inventory quantity is recorded accurately');
select is((select status from public.bookings where id=(select booking_id from expiry_test_ids where label='confirmed')),
  'confirmed'::text, 'confirmed booking is not expired');
select is((select quantity_sold from public.ticket_types where id=(select general_type_id from expiry_test_ids where label='confirmed')),
  1, 'confirmed booking sold inventory is unchanged');
select is((select count(*)::integer from public.payments p
  join expiry_test_ids x on x.booking_id=p.booking_id where x.label='confirmed' and p.status='successful'),
  1, 'already finalized payment remains successful');
select is((select status from public.bookings where id=(select booking_id from expiry_test_ids where label='expired')),
  'expired'::text, 'already expired booking remains expired');
select is((select count(*)::integer from public.booking_reservation_expiry_items
  where booking_id=(select booking_id from expiry_test_ids where label='expired') and outcome='expired'),
  0, 'already expired booking is not released again');

select lives_ok($test$select public.expire_expired_payment_reservations(500)$test$,
  'repeated expiry invocation succeeds');
select is((select count(*)::integer from public.booking_reservation_expiry_items
  where booking_id=(select booking_id from expiry_test_ids where label='multi') and outcome='expired'),
  1, 'repeated expiry does not release inventory twice');
select is((select count(*)::integer from public.booking_reservation_expiry_items
  where booking_id=(select booking_id from expiry_test_ids where label='late') and outcome='expired'),
  1, 'late payment reservation was expired exactly once');

select is(((public.finalize_verified_payment(
  (select payment_id from expiry_test_ids where label='late'),
  (select provider_reference from public.payments where id=(select payment_id from expiry_test_ids where label='late')),
  'expiry-late-txn',2000,'USD',null,null,now(),'{}'::jsonb))->>'result'),
  'manual_review'::text, 'late successful payment enters manual review instead of ticket fulfillment');
select is((select status from public.payments where id=(select payment_id from expiry_test_ids where label='late')),
  'successful'::text, 'late verified payment evidence is retained');
select is((select fulfillment_status from public.payments where id=(select payment_id from expiry_test_ids where label='late')),
  'manual_review'::text, 'late payment is not marked fulfilled');
select is((select status from public.bookings where id=(select booking_id from expiry_test_ids where label='late')),
  'expired'::text, 'late payment does not reopen its booking');
select is((select count(*)::integer from public.tickets where booking_id=(select booking_id from expiry_test_ids where label='late')),
  0, 'late payment does not issue tickets');
select is((select quantity_reserved from public.ticket_types where id=(select general_type_id from expiry_test_ids where label='late')),
  0, 'late payment does not restore or re-reserve inventory');

-- These structural assertions cover the lock-order contract. Exercise true
-- two-session interleavings against a migrated local database before rollout:
-- hold the payment row in session A, run expiry in session B (it must record
-- skipped_payment_lock), commit A, then run expiry again and inspect inventory.
select like(pg_get_functiondef('public.expire_expired_payment_reservations(integer)'::regprocedure),
  '%for update skip locked%', 'expiry uses non-blocking row-lock claims for concurrent runs');
select like(pg_get_functiondef('public.expire_expired_payment_reservations(integer)'::regprocedure),
  '%order by p.id%', 'payment rows are locked in a stable order');
select like(pg_get_functiondef('public.expire_expired_payment_reservations(integer)'::regprocedure),
  '%order by tt.id%', 'inventory rows are locked in a stable order');
select ok(position('from public.payments where id = p_payment_id for update' in
  pg_get_functiondef('public.finalize_verified_payment(uuid,text,text,bigint,text,bigint,bigint,timestamp with time zone,jsonb)')) > 0,
  'payment finalizer still obtains its payment lock before its booking lock');

select * from finish();
rollback;
