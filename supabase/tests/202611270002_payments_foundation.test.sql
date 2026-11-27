begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(32);

select ok((select relrowsecurity from pg_class where oid = 'public.payments'::regclass),
  'payments has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.payment_webhook_events'::regclass),
  'webhook event ledger has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.payment_refunds'::regclass),
  'refunds has RLS enabled');
select ok(not has_table_privilege('authenticated', 'public.payments', 'SELECT'),
  'authenticated users cannot read payment verification records');
select ok(not has_table_privilege('authenticated', 'public.payments', 'UPDATE'),
  'authenticated users cannot modify payments');
select ok(not has_table_privilege('anon', 'public.payment_webhook_events', 'INSERT'),
  'anonymous users cannot insert webhook events');
select ok(not has_table_privilege('authenticated', 'public.payment_refunds', 'UPDATE'),
  'authenticated users cannot modify refund records');
select ok(has_table_privilege('service_role', 'public.payments', 'INSERT'),
  'trusted server can create payment records');
select ok(exists(select 1 from pg_attribute where attrelid='public.payments'::regclass and attname='initialization_status' and not attisdropped),
  'payment initialization state is tracked separately');
select ok(to_regclass('public.payments_one_pending_attempt_per_booking') is not null,
  'a booking cannot have concurrent pending payment attempts');
select ok(has_function_privilege('service_role',
  'public.finalize_verified_payment(uuid,text,text,bigint,text,bigint,bigint,timestamp with time zone,jsonb)', 'EXECUTE'),
  'service role can finalize independently verified payments');
select ok(not has_function_privilege('authenticated',
  'public.finalize_verified_payment(uuid,text,text,bigint,text,bigint,bigint,timestamp with time zone,jsonb)', 'EXECUTE'),
  'authenticated users cannot call the finalizer');
select ok(not has_function_privilege('anon',
  'public.finalize_verified_payment(uuid,text,text,bigint,text,bigint,bigint,timestamp with time zone,jsonb)', 'EXECUTE'),
  'anonymous users cannot call the finalizer');

create temporary table payment_test_ids(label text primary key, payment_id uuid not null, booking_id uuid not null, event_id uuid not null, ticket_type_id uuid not null);
create temporary table payment_test_actor(id uuid primary key);

create function pg_temp.make_paid_fixture(
  p_label text,
  p_actor uuid,
  p_booking_status text default 'payment_pending',
  p_booking_quantity integer default 2,
  p_item_quantity integer default 2,
  p_reserved integer default 2,
  p_expiry_minutes integer default 10
) returns uuid
language plpgsql
as $$
declare
  v_event uuid;
  v_type uuid;
  v_booking uuid;
  v_item uuid;
  v_payment uuid;
begin
  insert into public.events(organizer_id,title,slug,description,category,location,country,start_date,status)
  values(p_actor,'Payment test ' || p_label,'payment-test-' || p_label || '-' || replace(gen_random_uuid()::text,'-',''),
    'Payment test event','Testing','Test City','Test Country',now()+interval '2 days','published')
  returning id into v_event;
  select id into v_type from public.ticket_types where event_id=v_event limit 1;
  insert into public.bookings(event_id,user_id,quantity,total_amount,currency,status,payment_status,expires_at,booking_reference)
  values(v_event,p_actor,p_booking_quantity,20,'USD',p_booking_status,'pending',
    now() + make_interval(mins => p_expiry_minutes),
    'NOD-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,12))) returning id into v_booking;
  insert into public.booking_items(booking_id,ticket_type_id,quantity,unit_price,currency)
  values(v_booking,v_type,p_item_quantity,20.0 / p_item_quantity,'USD') returning id into v_item;
  perform set_config('nodara.ticket_inventory_write','on',true);
  update public.ticket_types set quantity_reserved=p_reserved where id=v_type;
  perform set_config('nodara.ticket_inventory_write','off',true);
  insert into public.payments(booking_id,internal_reference,provider_reference,amount_minor,currency)
  values(v_booking,'pay-test-' || p_label || '-' || replace(gen_random_uuid()::text,'-',''),
    'provider-ref-' || p_label,2000,'USD')
  returning id into v_payment;
  insert into payment_test_ids values(p_label,v_payment,v_booking,v_event,v_type);
  return v_payment;
end;
$$;

do $$
declare v_actor uuid := gen_random_uuid();
begin
  insert into payment_test_actor values(v_actor);
  insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  values(v_actor,'authenticated','authenticated',v_actor::text || '@payment-test.invalid','',now(),'{}','{}',now(),now());
  perform pg_temp.make_paid_fixture('success',v_actor);
  perform pg_temp.make_paid_fixture('amount',v_actor);
  perform pg_temp.make_paid_fixture('currency',v_actor);
  perform pg_temp.make_paid_fixture('expired',v_actor,'payment_pending',2,2,2,-1);
  perform pg_temp.make_paid_fixture('cancelled',v_actor,'cancelled');
  perform pg_temp.make_paid_fixture('quantity',v_actor,'payment_pending',3,2,2);
  perform pg_temp.make_paid_fixture('inventory',v_actor,'payment_pending',2,2,1);
end;
$$;

do $$ begin perform set_config('request.jwt.claim.role','service_role',true); end $$;

select lives_ok($test$
  select public.finalize_verified_payment(
    (select payment_id from payment_test_ids where label='success'),
    'provider-ref-success','paystack-txn-success',2000,'USD',100,1900,now(),'{}'::jsonb)
$test$, 'valid verified payment finalizes booking and issues tickets');
select is((select status from public.bookings where id=(select booking_id from payment_test_ids where label='success')),
  'confirmed'::text, 'successful payment confirms the booking');
select is((select count(*)::integer from public.tickets where booking_id=(select booking_id from payment_test_ids where label='success')),
  2, 'finalization issues exactly the reserved ticket quantity');
select is((select quantity_reserved from public.ticket_types where id=(select ticket_type_id from payment_test_ids where label='success')),
  0, 'finalization releases the reserved inventory');
select is((select quantity_sold from public.ticket_types where id=(select ticket_type_id from payment_test_ids where label='success')),
  2, 'finalization moves reserved inventory to sold');

select lives_ok($test$
  select public.finalize_verified_payment(
    (select payment_id from payment_test_ids where label='success'),
    'provider-ref-success','paystack-txn-success',2000,'USD',100,1900,now(),'{}'::jsonb)
$test$, 'duplicate finalization is idempotent');
select is((select count(*)::integer from public.tickets where booking_id=(select booking_id from payment_test_ids where label='success')),
  2, 'duplicate finalization does not issue duplicate tickets');

select throws_ok($test$
  select public.finalize_verified_payment(
    (select payment_id from payment_test_ids where label='amount'),
    'provider-ref-amount','paystack-txn-amount',1999,'USD',null,null,now(),'{}'::jsonb)
$test$, 'P0001', 'Verified payment amount or currency does not match the booking', 'amount mismatch is rejected');
select throws_ok($test$
  select public.finalize_verified_payment(
    (select payment_id from payment_test_ids where label='currency'),
    'provider-ref-currency','paystack-txn-currency',2000,'EUR',null,null,now(),'{}'::jsonb)
$test$, 'P0001', 'Verified payment amount or currency does not match the booking', 'currency mismatch is rejected');

select is(((public.finalize_verified_payment(
    (select payment_id from payment_test_ids where label='expired'),
    'provider-ref-expired','paystack-txn-late',2000,'USD',null,null,now(),'{}'::jsonb))->>'result'),
  'manual_review'::text, 'expired reservation records payment for manual review');
select is((select fulfillment_status from public.payments where id=(select payment_id from payment_test_ids where label='expired')),
  'manual_review'::text, 'late payment is not marked fulfilled');
select is((select status from public.bookings where id=(select booking_id from payment_test_ids where label='expired')),
  'expired'::text, 'late payment does not reopen the booking');
select is((select count(*)::integer from public.tickets where booking_id=(select booking_id from payment_test_ids where label='expired')),
  0, 'late payment does not issue tickets');
select is((select quantity_reserved from public.ticket_types where id=(select ticket_type_id from payment_test_ids where label='expired')),
  0, 'expired reservation inventory is released without being reserved again');

select throws_ok($test$
  select public.finalize_verified_payment(
    (select payment_id from payment_test_ids where label='cancelled'),
    'provider-ref-cancelled','paystack-txn-cancelled',2000,'USD',null,null,now(),'{}'::jsonb)
$test$, 'P0001', 'Booking is not eligible for payment finalization', 'cancelled or invalid booking status is rejected');
select throws_ok($test$
  select public.finalize_verified_payment(
    (select payment_id from payment_test_ids where label='quantity'),
    'provider-ref-quantity','paystack-txn-quantity',2000,'USD',null,null,now(),'{}'::jsonb)
$test$, 'P0001', 'Booking items do not match the reserved booking', 'incorrect ticket quantity is rejected');
select throws_ok($test$
  select public.finalize_verified_payment(
    (select payment_id from payment_test_ids where label='inventory'),
    'provider-ref-inventory','paystack-txn-inventory',2000,'USD',null,null,now(),'{}'::jsonb)
$test$, 'P0001', 'Reserved ticket inventory is inconsistent', 'inconsistent reserved inventory is rejected');

do $$ begin perform set_config('request.jwt.claim.role','authenticated',true); end $$;
select throws_ok($test$
  select public.finalize_verified_payment(gen_random_uuid(),'provider-ref-unauthorized','unauthorized',2000,'USD',null,null,now(),'{}'::jsonb)
$test$, 'P0001', 'Trusted payment verifier required', 'RPC rejects callers without service_role identity');

do $$
declare v_actor uuid := (select id from payment_test_actor); v_event uuid; v_result jsonb; v_booking uuid;
begin
  insert into public.events(organizer_id,title,slug,description,category,location,country,start_date,status,price)
  values(v_actor,'Free payment compatibility','free-payment-' || replace(gen_random_uuid()::text,'-',''),
    'Free booking test','Testing','Test City','Test Country',now()+interval '2 days','published',0)
  returning id into v_event;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_actor::text,true);
  v_result := public.create_booking(v_event,
    (select jsonb_build_array(jsonb_build_object('ticket_type_id',id,'quantity',2)) from public.ticket_types where event_id=v_event));
  v_booking := (v_result->>'booking_id')::uuid;
  if (select status from public.bookings where id=v_booking) <> 'confirmed'
    or (select payment_status from public.bookings where id=v_booking) <> 'not_required'
    or (select count(*) from public.tickets where booking_id=v_booking) <> 2 then
    raise exception 'Existing free booking workflow changed';
  end if;
end;
$$;
select ok(true, 'existing free booking flow remains confirmed and issues tickets without payment rows');

select * from finish();
rollback;
