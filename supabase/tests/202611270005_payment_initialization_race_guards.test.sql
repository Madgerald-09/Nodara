begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(8);

create temporary table initialization_race_fixtures(
  label text primary key, actor_id uuid not null, booking_id uuid not null
);

do $$
declare
  v_actor uuid := gen_random_uuid();
  v_event uuid;
  v_booking uuid;
begin
  insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,
    raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  values(v_actor,'authenticated','authenticated',v_actor::text || '@init-race.invalid','',now(),'{}','{}',now(),now());
  insert into public.events(organizer_id,title,slug,description,category,location,country,start_date,status)
  values(v_actor,'Initialization race test','init-race-' || replace(gen_random_uuid()::text,'-',''),
    'Test fixture','Testing','Test City','Nigeria',now()+interval '2 days','published')
  returning id into v_event;
  insert into public.bookings(event_id,user_id,quantity,total_amount,currency,status,payment_status,expires_at,booking_reference)
  values(v_event,v_actor,1,25,'NGN','payment_pending','pending',now()+interval '10 minutes','INIT-RACE-ONE')
  returning id into v_booking;
  insert into initialization_race_fixtures values('active',v_actor,v_booking);
  insert into public.bookings(event_id,user_id,quantity,total_amount,currency,status,payment_status,expires_at,booking_reference)
  values(v_event,v_actor,1,25,'NGN','payment_pending','pending',now()-interval '1 minute','INIT-RACE-EXPIRED')
  returning id into v_booking;
  insert into initialization_race_fixtures values('expired',v_actor,v_booking);
end $$;

select set_config('request.jwt.claim.role','service_role',true);

select is((public.create_pending_paystack_payment(
  (select booking_id from initialization_race_fixtures where label='active'),
  (select actor_id from initialization_race_fixtures where label='active'),
  'NOD-INIT-RACE-ONE',2500,'NGN')->>'created')::boolean,true,
  'first initialization creates one pending payment');
select is((public.create_pending_paystack_payment(
  (select booking_id from initialization_race_fixtures where label='active'),
  (select actor_id from initialization_race_fixtures where label='active'),
  'NOD-INIT-RACE-TWO',2500,'NGN')->>'created')::boolean,false,
  'concurrent initialization receives the existing attempt without another provider call');
select is((select count(*)::integer from public.payments
  where booking_id=(select booking_id from initialization_race_fixtures where label='active') and status='pending'),
  1,'one active pending payment attempt exists per booking');
select is(public.save_paystack_initialization(
  (select id from public.payments where internal_reference='NOD-INIT-RACE-ONE'),
  'https://checkout.paystack.com/init-race'),true,'valid reservation stores checkout details');
select is((select checkout_url from public.payments where internal_reference='NOD-INIT-RACE-ONE'),
  'https://checkout.paystack.com/init-race'::text,'checkout URL is persisted for retry');
select throws_ok($test$
  select public.create_pending_paystack_payment(
    (select booking_id from initialization_race_fixtures where label='expired'),
    (select actor_id from initialization_race_fixtures where label='expired'),
    'NOD-INIT-RACE-EXPIRED',2500,'NGN')
$test$,'P0001','Booking reservation is no longer payable','expired reservations cannot create payment attempts');

do $$
declare v_booking uuid; v_actor uuid; v_payment uuid;
begin
  select booking_id,actor_id into v_booking,v_actor from initialization_race_fixtures where label='active';
  insert into public.bookings(event_id,user_id,quantity,total_amount,currency,status,payment_status,expires_at,booking_reference)
  select event_id,v_actor,1,25,'NGN','payment_pending','pending',now()+interval '10 minutes','INIT-RACE-EXPIRES-DURING-CHECKOUT'
  from public.bookings where id=v_booking returning id into v_booking;
  v_payment := (public.create_pending_paystack_payment(v_booking,v_actor,'NOD-INIT-RACE-EXPIRES-DURING-CHECKOUT',2500,'NGN')->>'id')::uuid;
  update public.bookings set status='expired' where id=v_booking;
  if public.save_paystack_initialization(v_payment,'https://checkout.paystack.com/stale') then
    raise exception 'stale checkout should not be returned';
  end if;
end $$;
select is((select status from public.payments where internal_reference='NOD-INIT-RACE-EXPIRES-DURING-CHECKOUT'),
  'failed'::text,'attempt created before expiry is closed if reservation expires before checkout is released');

select set_config('request.jwt.claim.role','authenticated',true);
select throws_ok($test$
  select public.create_pending_paystack_payment(gen_random_uuid(),gen_random_uuid(),'NOD-INIT-RACE-NOAUTH',2500,'NGN')
$test$,'P0001','Trusted payment initializer required','authenticated callers cannot create payment attempts');

select * from finish();
rollback;
