begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(37);

select ok((select relrowsecurity from pg_class where oid='public.community_public_info'::regclass), 'community public information has RLS');
select ok((select relrowsecurity from pg_class where oid='public.community_announcements'::regclass), 'announcements have RLS');
select ok((select relrowsecurity from pg_class where oid='public.community_announcement_history'::regclass), 'announcement history has RLS');
select ok((select relrowsecurity from pg_class where oid='public.community_event_highlights'::regclass), 'event highlights have RLS');
select ok(not has_column_privilege('anon','public.community_announcements','author_id','SELECT'), 'public queries cannot read announcement author account IDs');
select ok(not has_table_privilege('authenticated','public.community_announcements','INSERT'), 'announcement writes are restricted to checked RPCs');
select ok(has_function_privilege('anon','public.can_manage_community(uuid)','EXECUTE'), 'public RLS can safely evaluate the manager predicate');

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
 ('a1100000-0000-4000-8000-000000000001','authenticated','authenticated','community-owner@example.invalid','',now(),'{}','{}',now(),now()),
 ('a1100000-0000-4000-8000-000000000002','authenticated','authenticated','community-moderator@example.invalid','',now(),'{}','{}',now(),now()),
 ('a1100000-0000-4000-8000-000000000003','authenticated','authenticated','community-member@example.invalid','',now(),'{}','{}',now(),now());
insert into public.communities(id,creator_id,name,slug,description,category,location)
values
 ('a1110000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000001','Managed community','managed-community','Public community information','Culture','Lagos'),
 ('a1110000-0000-4000-8000-000000000002','a1100000-0000-4000-8000-000000000003','Separate community','separate-community','Other public community','Music','Abuja');
insert into public.community_members(community_id,user_id,role) values
 ('a1110000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000002','moderator'),
 ('a1110000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000003','member');
insert into public.events(id,organizer_id,title,slug,description,category,location,country,start_date,status)
values
 ('a1120000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000001','Upcoming public event','upcoming-public-event','Event fixture','Music','Lagos','Nigeria',now()+interval '5 days','published'),
 ('a1120000-0000-4000-8000-000000000002','a1100000-0000-4000-8000-000000000001','Draft event','draft-private-event','Event fixture','Music','Lagos','Nigeria',now()+interval '5 days','draft');

set local role authenticated;
select set_config('request.jwt.claim.sub','a1100000-0000-4000-8000-000000000003',true);
select throws_ok($$select public.create_community_announcement('a1110000-0000-4000-8000-000000000001','Unauthorised','Must not publish')$$,
  'P0001',null,'ordinary member cannot create an announcement');
select throws_ok($$insert into public.community_public_info(community_id,guidelines) values ('a1110000-0000-4000-8000-000000000001','forged')$$,
  '42501',null,'ordinary clients cannot directly edit community public information');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','a1100000-0000-4000-8000-000000000001',true);
select lives_ok($$select public.save_community_public_info('a1110000-0000-4000-8000-000000000001','https://community.example.org','["https://community.example.org/rules"]','Be welcoming. Respect event hosts.')$$,
  'community creator can publish validated information and guidelines');
select throws_ok($$select public.save_community_public_info('a1110000-0000-4000-8000-000000000001','javascript:alert(1)','[]','No')$$,
  'P0001',null,'unsafe public website schemes are rejected');
select lives_ok($$select public.create_community_announcement('a1110000-0000-4000-8000-000000000001','Community update','The next meetup is being planned.')$$,
  'community creator can create an announcement draft');
select lives_ok($$select public.edit_community_announcement((select id from public.community_announcements where title='Community update'),'Updated community update','The next meetup details will be shared here.')$$,
  'community creator can edit a draft and history is recorded');
select lives_ok($$select public.publish_community_announcement((select id from public.community_announcements where title='Updated community update'))$$,
  'community creator can publish the reviewed announcement');
select lives_ok($$select public.create_community_announcement('a1110000-0000-4000-8000-000000000001','Scheduled notice','This announcement will appear later.')$$,
  'manager can create a separate scheduled draft');
select lives_ok($$select public.schedule_community_announcement((select id from public.community_announcements where title='Scheduled notice'),now()+interval '1 day')$$,
  'manager can schedule for a future time');
select lives_ok($$select public.set_community_event_highlight('a1110000-0000-4000-8000-000000000001','a1120000-0000-4000-8000-000000000001',true)$$,
  'manager can highlight a published upcoming event');
select throws_ok($$select public.set_community_event_highlight('a1110000-0000-4000-8000-000000000001','a1120000-0000-4000-8000-000000000002',true)$$,
  'P0001',null,'draft events cannot be highlighted publicly');
reset role;

set local role anon;
select is((select count(*)::integer from public.community_announcements where status='published'),1,'public readers see published announcements only');
select is((select count(*)::integer from public.community_announcements where status='scheduled'),0,'scheduled announcements stay private before their time');
select is((select count(*)::integer from public.community_public_info where community_id='a1110000-0000-4000-8000-000000000001'),1,'community public information is readable without exposing members');
select is((select count(*)::integer from public.community_event_highlights where community_id='a1110000-0000-4000-8000-000000000001'),1,'only upcoming published highlighted events are public');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','a1100000-0000-4000-8000-000000000003',true);
select is((select count(*)::integer from public.community_announcements where status in ('draft','scheduled','archived')),0,'ordinary member cannot see private drafts or scheduled notices');
select lives_ok($$select public.submit_platform_report('announcement',(select id from public.community_announcements where title='Updated community update'),'incorrect_details','The venue details need review.')$$,
  'user can privately report a published announcement using the existing report system');
select is((select community_id from public.platform_reports where target_type='announcement' and reporter_id='a1100000-0000-4000-8000-000000000003'),
  'a1110000-0000-4000-8000-000000000001'::uuid,'announcement report records the correct community for moderator routing');
select is((select count(*)::integer from public.community_announcement_history),0,'ordinary member cannot inspect manager announcement history');
select throws_ok($$select public.publish_community_announcement((select id from public.community_announcements where title='Updated community update'))$$,
  'P0001',null,'ordinary member cannot publish an announcement');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','a1100000-0000-4000-8000-000000000002',true);
select lives_ok($$select public.edit_community_announcement((select id from public.community_announcements where title='Updated community update'),'Moderator edit','An authorised moderator may update official text.')$$,
  'community moderator can edit announcements');
select throws_ok($$select public.save_community_public_info('a1110000-0000-4000-8000-000000000002','https://example.org','[]','Cross community attempt')$$,
  'P0001',null,'moderator cannot manage a different community');
select is((select count(*)::integer from public.community_announcement_history),6,'manager can inspect announcement edit history');
select throws_ok($$update public.community_members set role='owner' where community_id='a1110000-0000-4000-8000-000000000001' and user_id='a1100000-0000-4000-8000-000000000002'$$,
  '42501',null,'moderators cannot promote themselves through membership writes');
select throws_ok($$select public.publish_due_community_announcements()$$,'42501',null,'authenticated users cannot invoke the scheduled publisher');
reset role;

-- Test the protected service worker against one due item, without installing a scheduler.
update public.community_announcements set scheduled_for=now()-interval '1 minute'
where title='Scheduled notice' and status='scheduled';
set local role service_role;
select set_config('request.jwt.claims',json_build_object('role','service_role','sub','a1100000-0000-4000-8000-000000000001','auth_time',extract(epoch from now())::bigint)::text,true);
select lives_ok($$select public.publish_due_community_announcements()$$,'service role can publish due announcements and record the system action');
reset role;
set local role anon;
select is((select count(*)::integer from public.community_announcements where title='Scheduled notice' and status='published'),1,'due item becomes public only after the trusted worker runs');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','a1100000-0000-4000-8000-000000000001',true);
select lives_ok($$select public.archive_community_announcement((select id from public.community_announcements where title='Updated community update'))$$,
  'community manager can archive an announcement');
select is((select count(*)::integer from public.community_announcements where title='Updated community update'),0,'archived announcements are hidden from public readers');
reset role;
set local role anon;
select ok(not has_table_privilege('anon','public.community_announcement_history','SELECT'),'announcement history is not publicly readable');
reset role;

select * from finish();
rollback;
