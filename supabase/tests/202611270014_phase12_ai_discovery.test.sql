begin;
create extension if not exists pgtap with schema extensions;
set local search_path=extensions,public;
select plan(10);

select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='public.ai_provider_rate_limits'::regclass),'rate limit data has RLS enabled and forced');
select ok(not has_table_privilege('anon','public.ai_provider_rate_limits','SELECT'),'anon cannot read rate-limit data');
select ok(not has_table_privilege('authenticated','public.ai_provider_rate_limits','INSERT'),'signed-in clients cannot write rate-limit data');
select ok(has_function_privilege('service_role','public.consume_ai_provider_request(uuid,text,integer,integer)','EXECUTE'),'service role can consume provider limits');
select ok(not has_function_privilege('anon','public.consume_ai_provider_request(uuid,text,integer,integer)','EXECUTE'),'anon cannot call the provider limit function');
select ok(not has_function_privilege('authenticated','public.consume_ai_provider_request(uuid,text,integer,integer)','EXECUTE'),'authenticated cannot call the provider limit function');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='public.consume_ai_provider_request(uuid,text,integer,integer)'::regprocedure),'rate limit function is SECURITY DEFINER with empty search_path');

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ('a1400000-0000-4000-8000-000000000001','authenticated','authenticated','phase12@example.invalid','',now(),'{}','{}',now(),now());
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select is(public.consume_ai_provider_request('a1400000-0000-4000-8000-000000000001','elevenlabs_tts',1,3600),true,'first request is allowed');
select is(public.consume_ai_provider_request('a1400000-0000-4000-8000-000000000001','elevenlabs_tts',1,3600),false,'excess request within a window is denied');
reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"a1400000-0000-4000-8000-000000000001"}',true);
select throws_ok($$select public.consume_ai_provider_request('a1400000-0000-4000-8000-000000000001','firecrawl',1,3600)$$,'42501',null,'direct authenticated invocation is rejected');
reset role;

select * from finish();
rollback;
