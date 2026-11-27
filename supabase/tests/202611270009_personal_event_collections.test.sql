begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(13);

select ok((select relrowsecurity from pg_class where oid='public.event_collections'::regclass), 'collections have RLS enabled');
select ok((select relrowsecurity from pg_class where oid='public.event_collection_items'::regclass), 'collection items have RLS enabled');
select ok(not has_table_privilege('anon','public.event_collections','SELECT'), 'anonymous users cannot read private collections');
select ok(not has_table_privilege('anon','public.event_collection_items','SELECT'), 'anonymous users cannot read private collection items');

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('a9000000-0000-4000-8000-000000000001','authenticated','authenticated','collection-owner@example.invalid','',now(),'{}','{}',now(),now()),
  ('a9000000-0000-4000-8000-000000000002','authenticated','authenticated','collection-other@example.invalid','',now(),'{}','{}',now(),now());
insert into public.events(id,organizer_id,title,slug,description,category,location,country,start_date,status)
values
  ('a9100000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-000000000001','Collection fixture','collection-fixture','Fixture event','Music','Lagos','Nigeria',now()+interval '3 days','published'),
  ('a9100000-0000-4000-8000-000000000002','a9000000-0000-4000-8000-000000000001','Unsaved fixture','unsaved-collection-fixture','Fixture event','Music','Lagos','Nigeria',now()+interval '4 days','published');
insert into public.saved_events(user_id,event_id) values ('a9000000-0000-4000-8000-000000000001','a9100000-0000-4000-8000-000000000001');
insert into public.event_collections(id,user_id,name) values
  ('a9200000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-000000000001','Fixture owner collection'),
  ('a9200000-0000-4000-8000-000000000002','a9000000-0000-4000-8000-000000000002','Other user collection'),
  ('a9200000-0000-4000-8000-000000000003','a9000000-0000-4000-8000-000000000001','Test collection');

set local role authenticated;
select set_config('request.jwt.claim.sub','a9000000-0000-4000-8000-000000000001',true);
select lives_ok($$insert into public.event_collections(user_id,name) values ('a9000000-0000-4000-8000-000000000001','Weekend ideas')$$,
  'user can create a private collection for themselves');
select throws_ok($$insert into public.event_collections(user_id,name) values ('a9000000-0000-4000-8000-000000000002','Impersonated')$$,
  '42501', null, 'user cannot create a collection for another account');
select is((select count(*)::integer from public.event_collections where user_id='a9000000-0000-4000-8000-000000000002'),0,
  'RLS hides another account collection');
select lives_ok($$insert into public.event_collection_items(collection_id,event_id)
  values ('a9200000-0000-4000-8000-000000000003','a9100000-0000-4000-8000-000000000001')$$,
  'user can add a saved event to an owned collection');
select throws_ok($$insert into public.event_collection_items(collection_id,event_id)
  values ('a9200000-0000-4000-8000-000000000003','a9100000-0000-4000-8000-000000000001')$$,
  '23505', null, 'duplicate collection entries are rejected');
select throws_ok($$insert into public.event_collection_items(collection_id,event_id)
  values ('a9200000-0000-4000-8000-000000000003','a9100000-0000-4000-8000-000000000002')$$,
  '42501', null, 'events not in the user's saved list cannot be added');
select is((select count(*)::integer from public.event_collection_items where collection_id='a9200000-0000-4000-8000-000000000002'),0,
  'collection items remain private to their owner');
select lives_ok($$delete from public.saved_events where user_id='a9000000-0000-4000-8000-000000000001'
  and event_id='a9100000-0000-4000-8000-000000000001'$$,
  'user can remove their own saved event');
select is((select count(*)::integer from public.event_collection_items where collection_id='a9200000-0000-4000-8000-000000000003'),0,
  'removing a saved event also removes it from the owner collections');

select * from finish();
rollback;
