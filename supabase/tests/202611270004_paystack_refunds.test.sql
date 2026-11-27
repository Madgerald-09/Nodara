begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(37);

select ok((select relrowsecurity from pg_class where oid='public.payment_refunds'::regclass), 'refund table has RLS enabled');
select ok((select relrowsecurity from pg_class where oid='public.payment_refund_items'::regclass), 'ticket refund items have RLS enabled');
select ok(not has_table_privilege('authenticated','public.payment_refunds','UPDATE'), 'authenticated clients cannot change refund state');
select ok(not has_table_privilege('authenticated','public.payment_refund_items','INSERT'), 'authenticated clients cannot choose refunded tickets directly');
select ok(has_table_privilege('service_role','public.payment_refund_items','INSERT'), 'trusted server can write refund item evidence');
select ok(not has_function_privilege('anon','public.request_paystack_refund(uuid,uuid,uuid,uuid[])','EXECUTE'), 'anonymous callers cannot request refunds');
select ok(not has_function_privilege('authenticated','public.request_paystack_refund(uuid,uuid,uuid,uuid[])','EXECUTE'), 'authenticated callers cannot bypass server validation');
select ok(not has_function_privilege('authenticated','public.finalize_verified_paystack_refund(uuid,text,text,text,bigint,text,text,timestamp with time zone)','EXECUTE'), 'authenticated callers cannot finalize provider evidence');
select ok(has_function_privilege('service_role','public.finalize_verified_paystack_refund(uuid,text,text,text,bigint,text,text,timestamp with time zone)','EXECUTE'), 'service role can synchronize verified refunds');
select like(pg_get_functiondef('public.request_paystack_refund(uuid,uuid,uuid,uuid[])'::regprocedure), '%auth.role()%service_role%', 'refund request RPC checks service role');
select like(pg_get_functiondef('public.request_paystack_refund(uuid,uuid,uuid,uuid[])'::regprocedure), '%FOR UPDATE%', 'refund request locks payment and ticket rows');
select like(pg_get_functiondef('public.request_paystack_refund(uuid,uuid,uuid,uuid[])'::regprocedure), '%ticket_transfer_history%', 'refund request rejects transferred tickets');
select like(pg_get_functiondef('public.request_paystack_refund(uuid,uuid,uuid,uuid[])'::regprocedure), '%ticket_checkin_history%', 'refund request rejects checked-in tickets');
select like(pg_get_functiondef('public.finalize_verified_paystack_refund(uuid,text,text,text,bigint,text,text,timestamp with time zone)'::regprocedure), '%provider_transaction_id%', 'refund finalizer checks payment transaction identity');

create temporary table refund_test_fixtures(
  label text primary key, payment_id uuid, booking_id uuid, event_id uuid,
  ticket_one uuid, ticket_two uuid, organizer_id uuid
);
create function pg_temp.make_refund_fixture(p_label text, p_payment_minor bigint, p_actor uuid)
returns void language plpgsql as $$
declare v_event uuid; v_type uuid; v_booking uuid; v_item uuid; v_payment uuid; v_one uuid; v_two uuid;
begin
  insert into public.events(organizer_id,title,slug,description,category,location,country,start_date,status)
  values(p_actor,'Refund test '||p_label,'refund-test-'||p_label||'-'||replace(gen_random_uuid()::text,'-',''),
    'Refund test event','Testing','Test City','Nigeria',now()+interval '2 days','published') returning id into v_event;
  select id into v_type from public.ticket_types where event_id=v_event limit 1;
  perform set_config('nodara.ticket_inventory_write','on',true);
  update public.ticket_types set price=12.50,currency='NGN',capacity=2,quantity_sold=2 where id=v_type;
  perform set_config('nodara.ticket_inventory_write','off',true);
  insert into public.bookings(event_id,user_id,quantity,total_amount,currency,status,payment_status,
    expires_at,booking_reference)
  values(v_event,p_actor,2,25,'NGN','confirmed','verified',now()+interval '1 day',
    'NOD-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12))) returning id into v_booking;
  insert into public.booking_items(booking_id,ticket_type_id,quantity,unit_price,currency)
  values(v_booking,v_type,2,12.50,'NGN') returning id into v_item;
  insert into public.payments(booking_id,provider,internal_reference,provider_reference,provider_transaction_id,
    amount_minor,currency,status,verified_at,fulfillment_status)
  values(v_booking,'paystack','internal-'||p_label,'charge-'||p_label,'1000'||p_label,
    p_payment_minor,'NGN','successful',now(),'fulfilled') returning id into v_payment;
  insert into public.tickets(booking_id,booking_item_id,event_id,ticket_type_id,user_id)
  values(v_booking,v_item,v_event,v_type,p_actor) returning id into v_one;
  insert into public.tickets(booking_id,booking_item_id,event_id,ticket_type_id,user_id)
  values(v_booking,v_item,v_event,v_type,p_actor) returning id into v_two;
  insert into refund_test_fixtures values(p_label,v_payment,v_booking,v_event,v_one,v_two,p_actor);
end;
$$;

do $$
declare v_actor uuid:=gen_random_uuid();
begin
  insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  values(v_actor,'authenticated','authenticated',v_actor::text||'@refund-test.invalid','',now(),'{}','{}',now(),now());
  perform pg_temp.make_refund_fixture('partial',2500,v_actor);
  perform pg_temp.make_refund_fixture('excess',1000,v_actor);
  perform pg_temp.make_refund_fixture('checkedin',2500,v_actor);
  perform pg_temp.make_refund_fixture('transferred',2500,v_actor);
  perform pg_temp.make_refund_fixture('onchain',2500,v_actor);
  update public.tickets set status='checked_in',checked_in_at=now() where id=(select ticket_one from refund_test_fixtures where label='checkedin');
  insert into public.ticket_transfer_history(ticket_id,event_id,from_wallet,to_wallet,transaction_signature)
  select ticket_one,event_id,'wallet-from','wallet-to','refund-test-transfer-'||replace(gen_random_uuid()::text,'-','')
  from refund_test_fixtures where label='transferred';
  update public.tickets set blockchain_status='verified' where id=(select ticket_one from refund_test_fixtures where label='onchain');
end $$;

select set_config('request.jwt.claim.role','service_role',true);

select lives_ok($test$
  select public.request_paystack_refund(payment_id,organizer_id,'11111111-1111-4111-8111-111111111111',array[ticket_one])
  from refund_test_fixtures where label='partial'
$test$, 'valid partial refund is reserved');
select is((select amount_minor from public.payment_refunds where request_key='11111111-1111-4111-8111-111111111111'),1250::bigint,
  'refund uses stored ticket price in integer minor units');
select is((select (public.request_paystack_refund(payment_id,organizer_id,'11111111-1111-4111-8111-111111111111',array[ticket_one])->>'idempotent')::boolean
  from refund_test_fixtures where label='partial'),true,'duplicate request with same key is idempotent');
select throws_ok($test$
  select public.request_paystack_refund(payment_id,organizer_id,'22222222-2222-4222-8222-222222222222',array[ticket_one])
  from refund_test_fixtures where label='partial'
$test$,'P0001',null,'duplicate active ticket refund is rejected');
select throws_ok($test$
  select public.request_paystack_refund(payment_id,organizer_id,'33333333-3333-4333-8333-333333333333',array[ticket_one])
  from refund_test_fixtures where label='excess'
$test$,'P0001',null,'refund amount exceeding payment balance is rejected');
select throws_ok($test$
  select public.request_paystack_refund(payment_id,organizer_id,'44444444-4444-4444-8444-444444444444',array[ticket_one])
  from refund_test_fixtures where label='checkedin'
$test$,'P0001',null,'already checked-in ticket refund is rejected');
select throws_ok($test$
  select public.request_paystack_refund(payment_id,organizer_id,'55555555-5555-4555-8555-555555555555',array[ticket_one])
  from refund_test_fixtures where label='transferred'
$test$,'P0001',null,'transferred ticket refund is rejected');
select throws_ok($test$
  select public.request_paystack_refund(payment_id,organizer_id,'88888888-8888-4888-8888-888888888888',array[ticket_one])
  from refund_test_fixtures where label='onchain'
$test$,'P0001',null,'on-chain tickets require verified invalidation before refund');
select throws_ok($test$
  select public.request_paystack_refund(payment_id,gen_random_uuid(),'99999999-9999-4999-8999-999999999999',array[ticket_one])
  from refund_test_fixtures where label='partial'
$test$,'P0001',null,'unrelated authenticated identity cannot request a refund');

select lives_ok($test$
  select public.finalize_verified_paystack_refund(
    (select id from public.payment_refunds where request_key='11111111-1111-4111-8111-111111111111'),
    (select refund_reference from public.payment_refunds where request_key='11111111-1111-4111-8111-111111111111'),
    'refund-provider-1','charge-partial',1250,'NGN','processing',now())
$test$, 'pending provider refund synchronization is accepted');
select is((select status from public.tickets where id=(select ticket_one from refund_test_fixtures where label='partial')),
  'issued'::text,'pending refund does not cancel ticket');
select throws_ok($test$
  update public.tickets set status='checked_in',checked_in_at=now()
  where id=(select ticket_one from refund_test_fixtures where label='partial')
$test$,'P0001',null,'check-in is blocked while refund is pending');
select lives_ok($test$
  select public.finalize_verified_paystack_refund(
    (select id from public.payment_refunds where request_key='11111111-1111-4111-8111-111111111111'),
    (select refund_reference from public.payment_refunds where request_key='11111111-1111-4111-8111-111111111111'),
    'refund-provider-1','charge-partial',1250,'NGN','processed',now())
$test$, 'verified successful refund finalizes');
select is((select status from public.tickets where id=(select ticket_one from refund_test_fixtures where label='partial')),
  'cancelled'::text,'successful partial refund cancels selected ticket');
select is((select status from public.tickets where id=(select ticket_two from refund_test_fixtures where label='partial')),
  'issued'::text,'successful partial refund preserves the unrefunded ticket');
select is((select status from public.payments where id=(select payment_id from refund_test_fixtures where label='partial')),
  'partially_refunded'::text,'payment records partial refund state');
select is((select (public.finalize_verified_paystack_refund(
    (select id from public.payment_refunds where request_key='11111111-1111-4111-8111-111111111111'),
    (select refund_reference from public.payment_refunds where request_key='11111111-1111-4111-8111-111111111111'),
    'refund-provider-1','charge-partial',1250,'NGN','processed',now())->>'idempotent')::boolean),
  true,'duplicate successful refund notification is idempotent');

select lives_ok($test$
  select public.request_paystack_refund(payment_id,organizer_id,'66666666-6666-4666-8666-666666666666',array[ticket_two])
  from refund_test_fixtures where label='partial'
$test$, 'remaining ticket can have a separate partial refund');
select lives_ok($test$
  select public.finalize_verified_paystack_refund(
    (select id from public.payment_refunds where request_key='66666666-6666-4666-8666-666666666666'),
    (select refund_reference from public.payment_refunds where request_key='66666666-6666-4666-8666-666666666666'),
    'refund-provider-2','charge-partial',1250,'NGN','failed',now())
$test$, 'provider failed refund is recorded');
select is((select status from public.tickets where id=(select ticket_two from refund_test_fixtures where label='partial')),
  'issued'::text,'failed refund leaves its ticket usable');
select lives_ok($test$
  select public.request_paystack_refund(payment_id,organizer_id,'77777777-7777-4777-8777-777777777777',array[ticket_two])
  from refund_test_fixtures where label='partial'
$test$, 'failed refund releases its ticket for a new approved request');
select lives_ok($test$
  select public.finalize_verified_paystack_refund(
    (select id from public.payment_refunds where request_key='77777777-7777-4777-8777-777777777777'),
    (select refund_reference from public.payment_refunds where request_key='77777777-7777-4777-8777-777777777777'),
    'refund-provider-3','charge-partial',1250,'NGN','processed',now())
$test$, 'remaining successful refund completes full refund');
select is((select status from public.payments where id=(select payment_id from refund_test_fixtures where label='partial')),
  'refunded'::text,'all ticket refunds move payment to refunded');

select * from finish();
rollback;
