begin;
create extension if not exists pgtap with schema extensions;
set local search_path=extensions,public;
select plan(14);

select ok(has_function_privilege('authenticated','public.get_organiser_analytics(timestamptz,timestamptz,uuid)','EXECUTE'),'signed-in users can call the protected aggregate RPC');
select ok(not has_function_privilege('anon','public.get_organiser_analytics(timestamptz,timestamptz,uuid)','EXECUTE'),'anonymous users cannot call the aggregate RPC');
select ok((select prosecdef from pg_proc where oid='public.get_organiser_analytics(timestamptz,timestamptz,uuid)'::regprocedure),'aggregate RPC is SECURITY DEFINER');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid='public.get_organiser_analytics(timestamptz,timestamptz,uuid)'::regprocedure),'aggregate RPC has an empty search_path');

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
 ('a1300000-0000-4000-8000-000000000001','authenticated','authenticated','analytics-one@example.invalid','',now(),'{}','{}',now(),now()),
 ('a1300000-0000-4000-8000-000000000002','authenticated','authenticated','analytics-two@example.invalid','',now(),'{}','{}',now(),now());

set local role service_role;
insert into public.events(id,organizer_id,title,slug,description,category,location,country,start_date,status)
values
 ('a1310000-0000-4000-8000-000000000001','a1300000-0000-4000-8000-000000000001','Analytics owner event','analytics-owner-event','Test event description','Technology','Lagos','Nigeria',now()+interval '10 days','published'),
 ('a1310000-0000-4000-8000-000000000002','a1300000-0000-4000-8000-000000000002','Other owner event','analytics-other-event','Private other event','Technology','Lagos','Nigeria',now()+interval '10 days','published');
insert into public.bookings(id,event_id,user_id,quantity,total_amount,currency,status,payment_status)
values
 ('a1320000-0000-4000-8000-000000000001','a1310000-0000-4000-8000-000000000001','a1300000-0000-4000-8000-000000000002',1,10,'USD','expired','verified'),
 ('a1320000-0000-4000-8000-000000000002','a1310000-0000-4000-8000-000000000001','a1300000-0000-4000-8000-000000000002',1,5,'EUR','expired','verified');
insert into public.payments(id,booking_id,internal_reference,provider_reference,provider_transaction_id,amount_minor,currency,status,initialization_status,verified_at,fulfillment_status)
values
 ('a1330000-0000-4000-8000-000000000001','a1320000-0000-4000-8000-000000000001','analytics-payment-usd','analytics-provider-usd','analytics-txn-usd',1000,'USD','partially_refunded','pending',now(),'manual_review'),
 ('a1330000-0000-4000-8000-000000000002','a1320000-0000-4000-8000-000000000002','analytics-payment-eur','analytics-provider-eur','analytics-txn-eur',500,'EUR','successful','pending',now(),'manual_review');
insert into public.payment_refunds(payment_id,refund_reference,request_key,amount_minor,currency,status,completed_at)
values ('a1330000-0000-4000-8000-000000000001','analytics-refund-usd','a1340000-0000-4000-8000-000000000001',400,'USD','succeeded',now());
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','a1300000-0000-4000-8000-000000000001',true);
select is(public.get_organiser_analytics(now()-interval '30 days',now()+interval '1 day',null)->'events'->>'total','1','organiser sees only their own event aggregate');
select throws_ok($$select public.get_organiser_analytics(now()-interval '30 days',now()+interval '1 day','a1310000-0000-4000-8000-000000000002')$$,'P0001',null,'organiser cannot request another organiser event');
select throws_ok($$select public.get_organiser_analytics(now(),now()-interval '1 day',null)$$,'P0001',null,'invalid date range is rejected');
select throws_ok($$select public.get_organiser_analytics(now()-interval '2 years',now(),null)$$,'P0001',null,'periods longer than 366 days are rejected');
select is((select (x->>'gross_minor')::bigint from jsonb_array_elements(public.get_organiser_analytics(now()-interval '30 days',now()+interval '1 day',null)->'financeByCurrency') x where x->>'currency'='USD'),1000::bigint,'verified payment gross is not combined with another currency');
select is((select (x->>'refunded_minor')::bigint from jsonb_array_elements(public.get_organiser_analytics(now()-interval '30 days',now()+interval '1 day',null)->'financeByCurrency') x where x->>'currency'='USD'),400::bigint,'only completed refunds reduce gross totals');
select is((select (x->>'gross_minor')::bigint-(x->>'refunded_minor')::bigint from jsonb_array_elements(public.get_organiser_analytics(now()-interval '30 days',now()+interval '1 day',null)->'financeByCurrency') x where x->>'currency'='USD'),600::bigint,'net verified amount subtracts completed refunds within that currency');
select is(jsonb_array_length(public.get_organiser_analytics(now()-interval '30 days',now()+interval '1 day',null)->'financeByCurrency'),2,'different currencies remain separate');
select is(public.get_organiser_analytics(now()-interval '30 days',now()+interval '1 day',null)->'inventory'->'capacity','null'::jsonb,'unlimited ticket types do not create a misleading finite inventory total');
reset role;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
set local role authenticated;
select throws_ok($$select public.get_organiser_analytics(now()-interval '30 days',now(),null)$$,'P0001',null,'missing authenticated user is rejected');
reset role;

select * from finish();
rollback;
