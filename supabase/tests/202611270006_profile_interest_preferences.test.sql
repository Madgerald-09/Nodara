begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(9);

select has_column('public', 'profiles', 'interest_categories', 'profile has category preference storage');
select ok(has_column_privilege('authenticated', 'public.profiles', 'interest_categories', 'UPDATE'),
  'authenticated can update the preference column');
select ok(has_column_privilege('service_role', 'public.profiles', 'interest_categories', 'UPDATE'),
  'service_role retains update access');
select ok((select relrowsecurity from pg_class where oid='public.profiles'::regclass),
  'profiles RLS remains enabled');
select ok((select column_default like '%{}%' from information_schema.columns
  where table_schema='public' and table_name='profiles' and column_name='interest_categories'),
  'new profiles default to no selected interests');

insert into auth.users(id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('a2000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'interests-a@example.invalid', '', now(), '{}', '{}', now(), now()),
  ('a2000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'interests-b@example.invalid', '', now(), '{}', '{}', now(), now());

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a2000000-0000-4000-8000-000000000001', true);
select lives_ok($$update public.profiles set interest_categories = array['Music', 'Technology']
  where id = 'a2000000-0000-4000-8000-000000000001'$$,
  'user can save interests on their own profile');
select lives_ok($$update public.profiles set interest_categories = array['Gaming']
  where id = 'a2000000-0000-4000-8000-000000000002'$$,
  'RLS rejects cross-user updates without exposing another profile');
select throws_ok($$update public.profiles set interest_categories = array['Not a category']
  where id = 'a2000000-0000-4000-8000-000000000001'$$, '23514', null,
  'database constraint rejects categories outside the supported list');
reset role;
select is((select interest_categories from public.profiles
  where id = 'a2000000-0000-4000-8000-000000000002'), '{}'::text[],
  'another user's preferences remain unchanged');

select * from finish();
rollback;
