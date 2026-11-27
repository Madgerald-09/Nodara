begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(19);

select ok(not has_table_privilege('anon', 'public.saved_events', 'SELECT'),
  'anonymous clients cannot read private save records');
select ok(not has_table_privilege('anon', 'public.bookings', 'SELECT'),
  'anonymous clients cannot read private booking records');
select ok(not has_table_privilege('anon', 'public.tickets', 'SELECT'),
  'anonymous clients cannot read private ticket records');
select ok(has_function_privilege('anon', 'public.get_trending_event_ranks(text)', 'EXECUTE'),
  'anonymous clients can request privacy-safe event ranks');
select ok(has_function_privilege('authenticated', 'public.get_trending_event_ranks(text)', 'EXECUTE'),
  'authenticated clients can request privacy-safe event ranks');
select ok(has_function_privilege('service_role', 'public.get_trending_event_ranks(text)', 'EXECUTE'),
  'service role retains event rank execution');
select ok((select prosecdef and 'search_path=""' = any(proconfig)
  from pg_proc where oid='public.get_trending_event_ranks(text)'::regprocedure),
  'event rank function is security definer with an empty search path');
select ok(has_function_privilege('anon', 'public.get_trending_communities(text)', 'EXECUTE'),
  'anonymous clients can request public community aggregates');
select ok((select prosecdef and 'search_path=""' = any(proconfig)
  from pg_proc where oid='public.get_trending_communities(text)'::regprocedure),
  'community rank function is security definer with an empty search path');
select throws_ok($$select * from public.get_trending_event_ranks('year')$$,
  'P0001', 'Unsupported trending period', 'unsupported event periods are rejected');
select throws_ok($$select * from public.get_trending_communities('all_time')$$,
  'P0001', 'Community trending supports week or month only', 'community all-time is not claimed without history');

-- Fixture rows are isolated to this transaction. Suppressing fixture triggers lets
-- the test represent already-confirmed bookings and check-ins without invoking flows.
set local session_replication_role = replica;
insert into auth.users(id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select ('b8000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'authenticated', 'authenticated', 'trend-' || n || '@example.invalid', '', now(), '{}', '{}', now(), now()
from generate_series(1, 6) n;
insert into public.profiles(id, full_name) select id, 'Trend fixture' from auth.users
where email like 'trend-%@example.invalid';

insert into public.events(id, organizer_id, title, slug, description, category, location, country,
  start_date, price, currency, status, created_at)
values
  ('b8100000-0000-4000-8000-000000000001','b8000000-0000-4000-8000-000000000001','Recent mixed activity','trend-recent-mixed','fixture','Music','Lagos','Nigeria',now()+interval '4 days',0,'NGN','published',now()),
  ('b8100000-0000-4000-8000-000000000002','b8000000-0000-4000-8000-000000000001','Several genuine users','trend-several-users','fixture','Music','Lagos','Nigeria',now()+interval '5 days',0,'NGN','published',now()),
  ('b8100000-0000-4000-8000-000000000003','b8000000-0000-4000-8000-000000000001','Older monthly activity','trend-old-month','fixture','Music','Lagos','Nigeria',now()+interval '8 days',0,'NGN','published',now()),
  ('b8100000-0000-4000-8000-000000000004','b8000000-0000-4000-8000-000000000001','Past event excluded','trend-past-event','fixture','Music','Lagos','Nigeria',now()-interval '1 day',0,'NGN','published',now()),
  ('b8100000-0000-4000-8000-000000000005','b8000000-0000-4000-8000-000000000001','Draft excluded','trend-draft-event','fixture','Music','Lagos','Nigeria',now()+interval '9 days',0,'NGN','draft',now()),
  ('b8100000-0000-4000-8000-000000000006','b8000000-0000-4000-8000-000000000001','Save only','trend-save-only','fixture','Music','Lagos','Nigeria',now()+interval '10 days',0,'NGN','published',now());

insert into public.communities(id, creator_id, name, slug, description, category, location, created_at)
values
  ('b8200000-0000-4000-8000-000000000001','b8000000-0000-4000-8000-000000000001','Recently joined','trend-community-recent','fixture','Music','Lagos',now()),
  ('b8200000-0000-4000-8000-000000000002','b8000000-0000-4000-8000-000000000001','Older active members','trend-community-older','fixture','Music','Lagos',now()-interval '5 days');
insert into public.community_members(community_id,user_id,role,joined_at) values
  ('b8200000-0000-4000-8000-000000000001','b8000000-0000-4000-8000-000000000002','member',now()-interval '1 day'),
  ('b8200000-0000-4000-8000-000000000001','b8000000-0000-4000-8000-000000000003','member',now()-interval '2 days'),
  ('b8200000-0000-4000-8000-000000000002','b8000000-0000-4000-8000-000000000004','member',now()-interval '10 days'),
  ('b8200000-0000-4000-8000-000000000002','b8000000-0000-4000-8000-000000000005','member',now()-interval '11 days');

insert into public.ticket_types(id,event_id,name,price,currency) values
  ('b8300000-0000-4000-8000-000000000001','b8100000-0000-4000-8000-000000000001','Fixture tier',0,'NGN');
insert into public.bookings(id,event_id,user_id,quantity,total_amount,currency,status,payment_status,created_at)
values
  ('b8400000-0000-4000-8000-000000000001','b8100000-0000-4000-8000-000000000001','b8000000-0000-4000-8000-000000000002',2,0,'NGN','confirmed','not_required',now()),
  ('b8400000-0000-4000-8000-000000000002','b8100000-0000-4000-8000-000000000002','b8000000-0000-4000-8000-000000000003',1,0,'NGN','confirmed','not_required',now()),
  ('b8400000-0000-4000-8000-000000000003','b8100000-0000-4000-8000-000000000002','b8000000-0000-4000-8000-000000000004',1,0,'NGN','confirmed','not_required',now()),
  ('b8400000-0000-4000-8000-000000000004','b8100000-0000-4000-8000-000000000002','b8000000-0000-4000-8000-000000000005',1,0,'NGN','confirmed','not_required',now()),
  ('b8400000-0000-4000-8000-000000000005','b8100000-0000-4000-8000-000000000003','b8000000-0000-4000-8000-000000000006',1,0,'NGN','confirmed','not_required',now()-interval '10 days'),
  ('b8400000-0000-4000-8000-000000000006','b8100000-0000-4000-8000-000000000004','b8000000-0000-4000-8000-000000000006',1,0,'NGN','confirmed','not_required',now()),
  ('b8400000-0000-4000-8000-000000000007','b8100000-0000-4000-8000-000000000005','b8000000-0000-4000-8000-000000000006',1,0,'NGN','confirmed','not_required',now());
insert into public.booking_items(id,booking_id,ticket_type_id,quantity,unit_price,currency) values
  ('b8500000-0000-4000-8000-000000000001','b8400000-0000-4000-8000-000000000001','b8300000-0000-4000-8000-000000000001',2,0,'NGN');
insert into public.tickets(id,booking_id,booking_item_id,event_id,ticket_type_id,user_id,holder_user_id,status,checked_in_at)
values
  ('b8600000-0000-4000-8000-000000000001','b8400000-0000-4000-8000-000000000001','b8500000-0000-4000-8000-000000000001','b8100000-0000-4000-8000-000000000001','b8300000-0000-4000-8000-000000000001','b8000000-0000-4000-8000-000000000002','b8000000-0000-4000-8000-000000000002','checked_in',now()),
  ('b8600000-0000-4000-8000-000000000002','b8400000-0000-4000-8000-000000000001','b8500000-0000-4000-8000-000000000001','b8100000-0000-4000-8000-000000000001','b8300000-0000-4000-8000-000000000001','b8000000-0000-4000-8000-000000000002','b8000000-0000-4000-8000-000000000002','checked_in',now());
insert into public.saved_events(event_id,user_id,created_at) values
  ('b8100000-0000-4000-8000-000000000001','b8000000-0000-4000-8000-000000000002',now()),
  ('b8100000-0000-4000-8000-000000000006','b8000000-0000-4000-8000-000000000003',now());
set local session_replication_role = origin;

select is((select trending_rank from public.get_trending_event_ranks('week') where event_id='b8100000-0000-4000-8000-000000000002'),
  1, 'distinct confirmed bookers rank the event with more unique attendees first');
select is((select trending_rank from public.get_trending_event_ranks('week') where event_id='b8100000-0000-4000-8000-000000000001'),
  2, 'multiple check-in ticket rows for one holder count once');
select is((select count(*)::integer from public.get_trending_event_ranks('week')), 3,
  'week results include only active engagement and exclude past and unpublished events');
select is((select trending_rank from public.get_trending_event_ranks('month') where event_id='b8100000-0000-4000-8000-000000000003'),
  3, 'monthly window includes older genuine engagement');
select ok(not exists(select 1 from public.get_trending_event_ranks('all_time') where event_id='b8100000-0000-4000-8000-000000000006'),
  'all-time ranking does not rely on saves whose deleted history is unavailable');
select is((select id from public.get_trending_communities('week') limit 1),
  'b8200000-0000-4000-8000-000000000001'::uuid, 'weekly community ranking uses recent active joins');
select is((select member_count from public.get_trending_communities('week') where id='b8200000-0000-4000-8000-000000000001'),
  2::bigint, 'community cards receive the exact current active member count');
select ok(exists(select 1 from public.get_trending_communities('month') where id='b8200000-0000-4000-8000-000000000002'),
  'monthly community ranking includes members who joined in the last 30 days');

select * from finish();
rollback;
