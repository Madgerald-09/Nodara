begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(7);

select ok(exists (
  select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname='ticket_checkin_history' and c.relrowsecurity
), 'verified check-in history has RLS enabled');
select ok(not has_table_privilege('authenticated','public.ticket_checkin_history','INSERT'),
  'authenticated clients cannot insert check-in history');
select ok(not has_table_privilege('authenticated','public.ticket_checkin_history','UPDATE'),
  'authenticated clients cannot update check-in history');
select ok(not has_function_privilege('authenticated',
  'public.record_verified_ticket_checkin(uuid,uuid,uuid,text,text,text,text,text)','EXECUTE'),
  'authenticated clients cannot call the trusted check-in synchronizer');
select ok(has_function_privilege('service_role',
  'public.record_verified_ticket_checkin(uuid,uuid,uuid,text,text,text,text,text)','EXECUTE'),
  'the service role can call the trusted check-in synchronizer');
select ok(exists (
  select 1 from pg_policies where schemaname='public' and tablename='ticket_checkin_history'
    and policyname='Organisers and current holders read verified check-ins'
), 'check-in history reads are limited by organiser or current-holder policies');
select ok(position('requires_on_chain' in pg_get_functiondef('public.check_in_ticket(uuid,text)'::regprocedure)) > 0,
  'legacy RPC refuses to mark a registered Solana ticket checked in');

select * from finish();
rollback;
