begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(30);

select ok((select relrowsecurity from pg_class where oid='public.platform_moderators'::regclass), 'moderator registry has RLS enabled');
select ok((select relrowsecurity from pg_class where oid='public.platform_reports'::regclass), 'reports have RLS enabled');
select ok((select relrowsecurity from pg_class where oid='public.platform_report_actions'::regclass), 'moderation audit has RLS enabled');
select ok((select relrowsecurity from pg_class where oid='public.account_deletion_requests'::regclass), 'deletion requests have RLS enabled');
select ok(not has_table_privilege('authenticated','public.platform_moderators','INSERT'), 'authenticated users cannot grant moderator access');
select ok(not has_table_privilege('authenticated','public.platform_reports','INSERT'), 'reports are inserted only through the validated RPC');
select ok(has_table_privilege('authenticated','public.platform_reports','SELECT'), 'report reads remain controlled by RLS');
select ok(not has_table_privilege('anon','public.platform_reports','SELECT'), 'anonymous visitors cannot read private reports');
select ok(not has_table_privilege('authenticated','public.platform_reports','UPDATE'), 'reporters cannot directly change moderation status');
select ok(not has_table_privilege('authenticated','public.platform_report_actions','INSERT'), 'clients cannot forge moderation audit history');
select ok(not has_table_privilege('authenticated','public.account_deletion_requests','INSERT'), 'clients must use the confirmed deletion request RPC');

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
 ('a0100000-0000-4000-8000-000000000001','authenticated','authenticated','privacy-a@example.invalid','',now(),'{}','{}',now(),now()),
 ('a0100000-0000-4000-8000-000000000002','authenticated','authenticated','privacy-b@example.invalid','',now(),'{}','{}',now(),now());
insert into public.events(id,organizer_id,title,slug,description,category,location,country,start_date,status)
values ('a0101000-0000-4000-8000-000000000001','a0100000-0000-4000-8000-000000000001','Privacy fixture','privacy-fixture','Public fixture','Music','Lagos','Nigeria',now()+interval '3 days','published'),
       ('a0101000-0000-4000-8000-000000000002','a0100000-0000-4000-8000-000000000001','Unpublished fixture','unpublished-fixture','Draft fixture','Music','Lagos','Nigeria',now()+interval '3 days','draft');
insert into public.communities(id,creator_id,name,slug,description,category)
values ('a0102000-0000-4000-8000-000000000001','a0100000-0000-4000-8000-000000000001','Privacy community','privacy-community','Community fixture','Community');

set local role authenticated;
select set_config('request.jwt.claim.sub','a0100000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims',json_build_object('sub','a0100000-0000-4000-8000-000000000001','role','authenticated','auth_time',extract(epoch from now())::bigint)::text,true);
select lives_ok($$select public.submit_platform_report('event','a0101000-0000-4000-8000-000000000001','incorrect_details','The time appears incorrect.')$$,
  'authenticated user can submit a validated report');
select is((select count(*)::integer from public.platform_reports),1,'reporter can see only their own submitted report');
select throws_ok($$insert into public.platform_reports(reporter_id,target_type,target_id,reason) values ('a0100000-0000-4000-8000-000000000001','event','a0101000-0000-4000-8000-000000000001','other')$$,
  '42501',null,'authenticated users cannot bypass report validation');
select throws_ok($$select public.submit_platform_report('event','a0101000-0000-4000-8000-000000000002','other',null)$$,
  'P0001',null,'unpublished event targets are rejected');
select throws_ok($$select public.submit_platform_report('event','a0101000-0000-4000-8000-000000000001','other',null)$$,
  'P0001',null,'duplicate open report is rejected');
select set_config('request.jwt.claims',json_build_object('sub','a0100000-0000-4000-8000-000000000001','role','authenticated','auth_time',1)::text,true);
select throws_ok($$select public.request_account_deletion('DELETE MY ACCOUNT')$$,'P0001',null,'old authentication cannot request account deletion');
select set_config('request.jwt.claims',json_build_object('sub','a0100000-0000-4000-8000-000000000001','role','authenticated','auth_time',extract(epoch from now())::bigint)::text,true);
select lives_ok($$select public.request_account_deletion('DELETE MY ACCOUNT')$$,'owner can request deletion after recent authentication and confirmation phrase');
select throws_ok($$select public.request_account_deletion('DELETE MY ACCOUNT')$$,'P0001',null,'duplicate active deletion request is rejected');
select is((select count(*)::integer from public.account_deletion_requests),1,'owner can see their own deletion request');
select is(public.cancel_account_deletion((select id from public.account_deletion_requests limit 1)),true,'owner can cancel a pending request');
select throws_ok($$insert into public.platform_moderators(user_id) values ('a0100000-0000-4000-8000-000000000001')$$,
  '42501',null,'ordinary user cannot promote themselves to moderator');
select throws_ok($$select public.review_platform_report((select id from public.platform_reports limit 1),'dismissed','Not valid','')$$,
  'P0001',null,'non-moderator cannot review or change a report');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','a0100000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims',json_build_object('sub','a0100000-0000-4000-8000-000000000002','role','authenticated','auth_time',extract(epoch from now())::bigint)::text,true);
select lives_ok($$select public.submit_platform_report('community','a0102000-0000-4000-8000-000000000001','other',null)$$,
  'second user can submit a separate report');
select is((select count(*)::integer from public.platform_reports),1,'reports from another account are not visible');
select is((select count(*)::integer from public.account_deletion_requests),0,'another account cannot see a deletion request');
reset role;

-- Test fixture provisioning represents trusted administrator action, not a client capability.
insert into public.platform_moderators(user_id) values ('a0100000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub','a0100000-0000-4000-8000-000000000002',true);
select lives_ok($$select public.review_platform_report((select id from public.platform_reports where reporter_id='a0100000-0000-4000-8000-000000000001' limit 1),'under_review','Review started',null)$$,
  'trusted moderator can record a review action');
select is((select count(*)::integer from public.platform_report_actions),1,'moderator can view the audit record');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','a0100000-0000-4000-8000-000000000001',true);
select is((select count(*)::integer from public.platform_report_actions),0,'reporter cannot view internal moderation audit or notes');
select is((select status from public.platform_reports limit 1),'under_review','reporter can see status but cannot alter moderation outcome');
reset role;

select * from finish();
rollback;
