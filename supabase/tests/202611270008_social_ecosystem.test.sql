begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(26);

select has_column('public','profiles','is_discoverable','profiles have opt-in discoverability');
select has_column('public','profiles','show_location','locations require explicit display choice');
select has_column('public','profiles','show_interests','interests require explicit display choice');
select has_table('public','user_follows','follow relationships are stored');
select has_table('public','user_blocks','blocks are stored privately');
select has_table('public','social_posts','posts are stored');
select has_table('public','social_reactions','reactions are stored');
select has_table('public','social_comments','comments are stored');
select has_table('public','community_posts','community posts are stored');
select has_table('public','social_notifications','notifications are stored');
select has_table('public','content_reports','reports are stored privately');
select has_table('public','community_moderation_actions','moderation actions are audited');

select is((select count(*)::integer from pg_class where oid=any(array[
  'public.user_follows'::regclass,'public.user_blocks'::regclass,'public.social_posts'::regclass,
  'public.social_reactions'::regclass,'public.social_comments'::regclass,'public.community_posts'::regclass,
  'public.social_notifications'::regclass,'public.content_reports'::regclass,'public.community_moderation_actions'::regclass
]) and relrowsecurity),9,'RLS is enabled on every new social table');
select ok((select relrowsecurity from pg_class where oid='public.profiles'::regclass),'profile RLS remains enabled');
select ok(not has_table_privilege('anon','public.user_follows','SELECT'),'anonymous users cannot read follow edges');
select ok(not has_table_privilege('authenticated','public.user_blocks','SELECT') or exists(
  select 1 from pg_policies where schemaname='public' and tablename='user_blocks' and cmd='SELECT'
),'block reads remain policy-protected');
select ok(not has_table_privilege('anon','public.content_reports','SELECT'),'reports are never public');
select ok(not has_table_privilege('authenticated','public.content_reports','UPDATE'),'reporters cannot edit report status');
select ok(not has_table_privilege('authenticated','public.social_notifications','INSERT'),'clients cannot forge notifications');
select ok(not has_column_privilege('authenticated','public.community_members','role','UPDATE'),'clients cannot promote community roles');

select ok((select prosecdef and 'search_path=""'=any(proconfig) from pg_proc where oid='public.get_public_profiles(text,integer,integer)'::regprocedure),
  'profile search is a security definer with an empty search path');
select ok((select prosecdef and 'search_path=""'=any(proconfig) from pg_proc where oid='public.get_social_feed(timestamp with time zone,uuid,integer,uuid)'::regprocedure),
  'social feed is a security definer with an empty search path');
select ok(has_function_privilege('anon','public.get_public_profiles(text,integer,integer)','EXECUTE'),'anonymous profile search uses the safe RPC');
select ok(has_function_privilege('authenticated','public.create_social_moderation_action(uuid,text,text)','EXECUTE'),'moderators can invoke the authorization-checked moderation RPC');
select ok(not has_function_privilege('anon','public.create_social_moderation_action(uuid,text,text)','EXECUTE'),'anonymous users cannot invoke moderation');
select ok(has_function_privilege('service_role','public.get_public_profile(text)','EXECUTE'),'service role access is preserved');

select * from finish();
rollback;
