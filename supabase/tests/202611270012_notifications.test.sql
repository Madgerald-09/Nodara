begin;
create extension if not exists pgtap with schema extensions;
set local search_path=extensions,public;
select plan(30);

select ok((select relrowsecurity from pg_class where oid='public.notification_preferences'::regclass),'preference RLS enabled');
select ok((select relrowsecurity from pg_class where oid='public.notifications'::regclass),'notification RLS enabled');
select ok((select relrowsecurity from pg_class where oid='public.notification_deliveries'::regclass),'delivery RLS enabled');
select ok(not has_table_privilege('authenticated','public.notifications','INSERT'),'users cannot create notifications directly');
select ok(not has_table_privilege('authenticated','public.notifications','DELETE'),'users cannot delete notification records');
select ok(has_column_privilege('authenticated','public.notifications','read_at','UPDATE'),'users may update only the read timestamp');
select ok(not has_table_privilege('authenticated','public.notification_deliveries','SELECT'),'delivery diagnostics stay private');
select ok(not has_function_privilege('authenticated','public.enqueue_due_event_reminders()','EXECUTE'),'users cannot run the reminder scheduler RPC');
select ok(not has_function_privilege('authenticated','public.claim_notification_email_batch(integer)','EXECUTE'),'users cannot claim delivery work');

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
 ('a1200000-0000-4000-8000-000000000001','authenticated','authenticated','notify-one@example.invalid','',now(),'{}','{}',now(),now()),
 ('a1200000-0000-4000-8000-000000000002','authenticated','authenticated','notify-two@example.invalid','',now(),'{}','{}',now(),now());

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select ok(public.enqueue_user_notification('a1200000-0000-4000-8000-000000000001','events','test_event','Test update','A safe test message.',null,null,'test-notification:one') is not null,'trusted generation inserts the first notification');
select is((select count(*)::integer from public.notifications where idempotency_key='test-notification:one'),1,'first generated notification is stored once');
select is(public.enqueue_user_notification('a1200000-0000-4000-8000-000000000001','events','test_event','Test update','A safe test message.',null,null,'test-notification:one'),null::uuid,'duplicate idempotency key produces no second notification');
select is(public.enqueue_user_notification('a1200000-0000-4000-8000-000000000001','events','invalid_resource','Invalid link','This resource does not exist.','event','a1210000-0000-4000-8000-000000000001'::uuid,'test-notification:invalid'),null::uuid,'invalid related event references are rejected');
select is((select count(*)::integer from public.notification_deliveries where notification_id=(select id from public.notifications where idempotency_key='test-notification:one')),2,'in-app and email channels are queued once');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','a1200000-0000-4000-8000-000000000001',true);
select is((select count(*)::integer from public.notifications),1,'recipient can read their own notification');
select lives_ok($$update public.notifications set read_at=now() where idempotency_key='test-notification:one'$$,'recipient can mark own notification read');
select throws_ok($$insert into public.notifications(recipient_id,category,notification_type,title,message,idempotency_key) values ('a1200000-0000-4000-8000-000000000001','events','forged','Forged','Client message','forged-notification')$$,'42501',null,'authenticated clients cannot forge notification rows');
select throws_ok($$select public.enqueue_user_notification('a1200000-0000-4000-8000-000000000001','events','forged','Forged','Client message',null,null,'forged-notification')$$,'42501',null,'authenticated users cannot invoke trusted notification generation');
select throws_ok($$select public.enqueue_due_event_reminders()$$,'42501',null,'authenticated users cannot invoke reminder scheduling');
select throws_ok($$select * from public.claim_notification_email_batch(10)$$,'42501',null,'authenticated users cannot claim email deliveries');
select lives_ok($$select public.set_notification_preferences('{"bookings":true,"tickets":true,"payments":true,"refunds":true,"events":true,"reminders":true,"communities":true,"announcements":true,"organiser_updates":true}','{"bookings":true,"tickets":true,"payments":true,"refunds":true,"events":false,"reminders":true,"communities":true,"announcements":true,"organiser_updates":true}')$$,'user can update only their own validated preferences');
select throws_ok($$select public.set_notification_preferences('{"events":"yes"}','{}')$$,'P0001',null,'invalid preference shapes are rejected');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','a1200000-0000-4000-8000-000000000002',true);
select is((select count(*)::integer from public.notifications),0,'another account cannot read the recipient notification');
select is((with changed as (update public.notifications set read_at=now() where idempotency_key='test-notification:one' returning id) select count(*)::integer from changed),0,'another account cannot update the recipient read state');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','a1200000-0000-4000-8000-000000000001',true);
select lives_ok($$select public.set_notification_preferences('{"bookings":true,"tickets":true,"payments":true,"refunds":true,"events":false,"reminders":true,"communities":true,"announcements":true,"organiser_updates":true}','{"bookings":true,"tickets":true,"payments":true,"refunds":true,"events":false,"reminders":true,"communities":true,"announcements":true,"organiser_updates":true}')$$,'user can opt out of in-app event notices');
select is((select count(*)::integer from public.notifications),0,'RLS hides event notices after the in-app category is disabled');
reset role;

-- Published announcements notify current community members; drafts do not.
set local role service_role;
insert into public.communities(id,creator_id,name,slug,description,category)
values('a1220000-0000-4000-8000-000000000001','a1200000-0000-4000-8000-000000000001','Notification community','notification-community','Test community information','Community');
insert into public.community_members(community_id,user_id,role)
values('a1220000-0000-4000-8000-000000000001','a1200000-0000-4000-8000-000000000002','member');
insert into public.community_announcements(id,community_id,author_id,title,body,status)
values('a1230000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000001','a1200000-0000-4000-8000-000000000001','Draft announcement','Draft content','draft');
select is((select count(*)::integer from public.notifications where related_resource_id='a1230000-0000-4000-8000-000000000001'),0,'draft announcement creates no notification');
update public.community_announcements set status='published',published_at=now() where id='a1230000-0000-4000-8000-000000000001';
select is((select count(*)::integer from public.notifications where related_resource_id='a1230000-0000-4000-8000-000000000001'),2,'published announcement notifies eligible community members');
select is((select count(*)::integer from public.notifications where related_resource_id='a1230000-0000-4000-8000-000000000001' and recipient_id='a1200000-0000-4000-8000-000000000002'),1,'published announcement notifies the eligible member');
update public.community_announcements set title='Edited after publication' where id='a1230000-0000-4000-8000-000000000001';
select is((select count(*)::integer from public.notifications where related_resource_id='a1230000-0000-4000-8000-000000000001'),2,'editing a published announcement does not resend publication notices');
reset role;

select * from finish();
rollback;
