begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(23);

select ok((select relrowsecurity from pg_class where oid='public.profiles'::regclass), 'profiles uses RLS');
select ok((select relrowsecurity from pg_class where oid='public.bookings'::regclass), 'bookings uses RLS');
select ok((select relrowsecurity from pg_class where oid='public.tickets'::regclass), 'tickets use RLS');
select ok((select relrowsecurity from pg_class where oid='public.saved_events'::regclass), 'saved events use RLS');
select ok((select relrowsecurity from pg_class where oid='public.community_members'::regclass), 'community memberships use RLS');
select ok((select relrowsecurity from pg_class where oid='public.ticket_checkin_history'::regclass), 'check-in records use RLS');

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('a9300000-0000-4000-8000-000000000001','authenticated','authenticated','activity-owner@example.invalid','',now(),'{}','{"full_name":"Activity Owner"}',now(),now()),
  ('a9300000-0000-4000-8000-000000000002','authenticated','authenticated','activity-other@example.invalid','',now(),'{}','{"full_name":"Other Account"}',now(),now());

insert into public.events(id,organizer_id,title,slug,description,category,location,country,start_date,status,price)
values ('a9310000-0000-4000-8000-000000000001','a9300000-0000-4000-8000-000000000001',
  'Activity Dashboard Fixture','activity-dashboard-fixture','Private dashboard test event','Testing','Lagos','Nigeria',
  now()+interval '5 days','published',0);

insert into public.bookings(id,event_id,user_id,quantity,total_amount,currency,status,payment_status,booking_reference)
values
  ('a9320000-0000-4000-8000-000000000001','a9310000-0000-4000-8000-000000000001','a9300000-0000-4000-8000-000000000001',1,0,'USD','confirmed','not_required','NOD-ACTIVITY0001'),
  ('a9320000-0000-4000-8000-000000000002','a9310000-0000-4000-8000-000000000001','a9300000-0000-4000-8000-000000000002',1,0,'USD','confirmed','not_required','NOD-ACTIVITY0002');

insert into public.booking_items(id,booking_id,ticket_type_id,quantity,unit_price,currency)
select 'a9330000-0000-4000-8000-000000000001','a9320000-0000-4000-8000-000000000001',id,1,0,'USD'
from public.ticket_types where event_id='a9310000-0000-4000-8000-000000000001' limit 1;
insert into public.booking_items(id,booking_id,ticket_type_id,quantity,unit_price,currency)
select 'a9330000-0000-4000-8000-000000000002','a9320000-0000-4000-8000-000000000002',id,1,0,'USD'
from public.ticket_types where event_id='a9310000-0000-4000-8000-000000000001' limit 1;

insert into public.tickets(id,booking_id,booking_item_id,event_id,ticket_type_id,user_id,holder_user_id,status,checked_in_at)
select 'a9340000-0000-4000-8000-000000000001','a9320000-0000-4000-8000-000000000001',bi.id,
  'a9310000-0000-4000-8000-000000000001',bi.ticket_type_id,'a9300000-0000-4000-8000-000000000001',
  'a9300000-0000-4000-8000-000000000001','checked_in',now()
from public.booking_items bi where bi.id='a9330000-0000-4000-8000-000000000001';
insert into public.tickets(id,booking_id,booking_item_id,event_id,ticket_type_id,user_id,holder_user_id)
select 'a9340000-0000-4000-8000-000000000002','a9320000-0000-4000-8000-000000000002',bi.id,
  'a9310000-0000-4000-8000-000000000001',bi.ticket_type_id,'a9300000-0000-4000-8000-000000000002',
  'a9300000-0000-4000-8000-000000000002'
from public.booking_items bi where bi.id='a9330000-0000-4000-8000-000000000002';

insert into public.ticket_checkin_history(ticket_id,event_id,organizer_user_id,organizer_wallet,transaction_signature)
values ('a9340000-0000-4000-8000-000000000001','a9310000-0000-4000-8000-000000000001',
  'a9300000-0000-4000-8000-000000000001','activity-test-wallet','activity-test-signature');
insert into public.saved_events(user_id,event_id) values
  ('a9300000-0000-4000-8000-000000000001','a9310000-0000-4000-8000-000000000001'),
  ('a9300000-0000-4000-8000-000000000002','a9310000-0000-4000-8000-000000000001');
insert into public.communities(id,creator_id,name,slug,description,category)
values ('a9350000-0000-4000-8000-000000000001','a9300000-0000-4000-8000-000000000001',
  'Activity Test Community','activity-test-community','Community fixture','Testing');
insert into public.community_members(community_id,user_id,role)
values ('a9350000-0000-4000-8000-000000000001','a9300000-0000-4000-8000-000000000002','member');

set local role authenticated;
select set_config('request.jwt.claim.sub','a9300000-0000-4000-8000-000000000001',true);
select is((select count(*)::integer from public.profiles where id='a9300000-0000-4000-8000-000000000001'),1,'user can read their own profile');
select is((select count(*)::integer from public.profiles where id='a9300000-0000-4000-8000-000000000002'),0,'user cannot read another profile');
select is((select count(*)::integer from public.bookings where user_id='a9300000-0000-4000-8000-000000000001'),1,'user can read their own booking');
select is((select count(*)::integer from public.bookings where user_id='a9300000-0000-4000-8000-000000000002'),0,'user cannot read another booking');
select is((select count(*)::integer from public.get_my_bookings()),1,'booking RPC returns only the signed-in user booking');
select is((select count(*)::integer from public.tickets where holder_user_id='a9300000-0000-4000-8000-000000000001'),1,'user can read their current ticket');
select is((select count(*)::integer from public.tickets where holder_user_id='a9300000-0000-4000-8000-000000000002'),0,'user cannot read another current ticket');
select is((select count(*)::integer from public.get_my_tickets()),1,'ticket RPC returns only tickets assigned to the signed-in user');
select is((select count(*)::integer from public.ticket_checkin_history where ticket_id='a9340000-0000-4000-8000-000000000001'),1,'current holder can read their verified check-in');
select is((select count(*)::integer from public.saved_events where user_id='a9300000-0000-4000-8000-000000000001'),1,'user can read their own saved event');
select is((select count(*)::integer from public.saved_events where user_id='a9300000-0000-4000-8000-000000000002'),0,'user cannot read another saved event');
select is((select count(*)::integer from public.community_members where user_id='a9300000-0000-4000-8000-000000000001'),1,'user can read their own community membership');
select is((select count(*)::integer from public.community_members where user_id='a9300000-0000-4000-8000-000000000002'),0,'user cannot read another membership');

select set_config('request.jwt.claim.sub','a9300000-0000-4000-8000-000000000002',true);
select is((select count(*)::integer from public.get_my_bookings()),1,'second user receives only their own booking through RPC');
select is((select count(*)::integer from public.get_my_tickets()),1,'second user receives only their own ticket through RPC');
select is((select count(*)::integer from public.ticket_checkin_history where ticket_id='a9340000-0000-4000-8000-000000000001'),0,'another user cannot read a holder check-in record');
select is((select count(*)::integer from public.profiles where id='a9300000-0000-4000-8000-000000000001'),0,'second user cannot inspect first user profile');

select * from finish();
rollback;
