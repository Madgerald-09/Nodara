-- NODARA production catalog audit (READ ONLY)
-- Run this as one statement in the Supabase SQL Editor. It reads PostgreSQL
-- catalogs only. The optional migration-history read is a fixed SELECT passed
-- to query_to_xml and is skipped when the relation is absent.
with
target_tables(table_name) as (
  values
    ('tickets'),
    ('ticket_transfer_history'),
    ('ticket_checkin_history'),
    ('solana_reconciliation_runs'),
    ('solana_reconciliation_audit')
),
target_functions(function_name) as (
  values
    ('record_verified_ticket_checkin'),
    ('record_verified_ticket_transfer'),
    ('start_solana_reconciliation_run'),
    ('finish_solana_reconciliation_run'),
    ('apply_solana_ticket_reconciliation')
),
table_oids as (
  select tt.table_name, c.oid as table_oid, n.nspname as schema_name,
         c.relrowsecurity, c.relforcerowsecurity, c.relkind, c.relowner,
         c.relacl
  from target_tables tt
  left join pg_catalog.pg_class c
    on c.relnamespace = 'public'::pg_catalog.regnamespace
   and c.relname = tt.table_name
  left join pg_catalog.pg_namespace n on n.oid = c.relnamespace
),
function_oids as (
  select tf.function_name, p.oid as function_oid, n.nspname as schema_name
  from target_functions tf
  left join pg_catalog.pg_proc p
    on p.pronamespace = 'public'::pg_catalog.regnamespace
   and p.proname = tf.function_name
  left join pg_catalog.pg_namespace n on n.oid = p.pronamespace
),
table_report as (
  select jsonb_object_agg(t.table_name,
    case when t.table_oid is null then jsonb_build_object('exists', false)
    else jsonb_build_object(
      'exists', true,
      'schema', t.schema_name,
      'kind', t.relkind,
      'rls', jsonb_build_object('enabled', t.relrowsecurity, 'forced', t.relforcerowsecurity),
      'columns', coalesce((
        select jsonb_agg(jsonb_build_object(
          'ordinal', a.attnum,
          'name', a.attname,
          'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
          'nullable', not a.attnotnull,
          'default', pg_catalog.pg_get_expr(d.adbin, d.adrelid),
          'identity', a.attidentity,
          'generated', a.attgenerated
        ) order by a.attnum)
        from pg_catalog.pg_attribute a
        left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = t.table_oid and a.attnum > 0 and not a.attisdropped
      ), '[]'::jsonb),
      'constraints', coalesce((
        select jsonb_agg(jsonb_build_object(
          'name', c.conname,
          'type', case c.contype when 'p' then 'primary_key' when 'f' then 'foreign_key'
            when 'u' then 'unique' when 'c' then 'check' when 'x' then 'exclusion' else c.contype::text end,
          'definition', pg_catalog.pg_get_constraintdef(c.oid, true),
          'validated', c.convalidated,
          'referencedTable', case when c.confrelid <> 0 then c.confrelid::pg_catalog.regclass::text end
        ) order by c.contype, c.conname)
        from pg_catalog.pg_constraint c where c.conrelid = t.table_oid
      ), '[]'::jsonb),
      'indexes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'name', i.relname,
          'definition', pg_catalog.pg_get_indexdef(i.oid),
          'unique', ix.indisunique,
          'primary', ix.indisprimary,
          'valid', ix.indisvalid,
          'ready', ix.indisready
        ) order by i.relname)
        from pg_catalog.pg_index ix
        join pg_catalog.pg_class i on i.oid = ix.indexrelid
        where ix.indrelid = t.table_oid
      ), '[]'::jsonb),
      'triggers', coalesce((
        select jsonb_agg(jsonb_build_object(
          'name', g.tgname,
          'enabled', g.tgenabled,
          'definition', pg_catalog.pg_get_triggerdef(g.oid, true),
          'function', g.tgfoid::pg_catalog.regprocedure::text
        ) order by g.tgname)
        from pg_catalog.pg_trigger g
        where g.tgrelid = t.table_oid and not g.tgisinternal
      ), '[]'::jsonb),
      'policies', coalesce((
        select jsonb_agg(jsonb_build_object(
          'name', pol.polname,
          'command', case pol.polcmd when '*' then 'ALL' when 'r' then 'SELECT' when 'a' then 'INSERT'
            when 'w' then 'UPDATE' when 'd' then 'DELETE' else pol.polcmd::text end,
          'permissive', pol.polpermissive,
          'roles', coalesce((select jsonb_agg(case when role_entry.role_oid = 0 then 'PUBLIC' else role_entry.role_oid::pg_catalog.regrole::text end)
            from unnest(pol.polroles) as role_entry(role_oid)), '[]'::jsonb),
          'using', pg_catalog.pg_get_expr(pol.polqual, pol.polrelid),
          'withCheck', pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid)
        ) order by pol.polname)
        from pg_catalog.pg_policy pol where pol.polrelid = t.table_oid
      ), '[]'::jsonb),
      'privileges', jsonb_build_object(
        'PUBLIC', coalesce((select jsonb_agg(x.privilege_type order by x.privilege_type)
          from pg_catalog.aclexplode(coalesce(t.relacl, pg_catalog.acldefault('r', t.relowner))) x
          where x.grantee = 0), '[]'::jsonb),
        'anon', jsonb_build_object(
          'select', has_table_privilege('anon', t.table_oid, 'SELECT'), 'insert', has_table_privilege('anon', t.table_oid, 'INSERT'),
          'update', has_table_privilege('anon', t.table_oid, 'UPDATE'), 'delete', has_table_privilege('anon', t.table_oid, 'DELETE'),
          'truncate', has_table_privilege('anon', t.table_oid, 'TRUNCATE'), 'references', has_table_privilege('anon', t.table_oid, 'REFERENCES'), 'trigger', has_table_privilege('anon', t.table_oid, 'TRIGGER')),
        'authenticated', jsonb_build_object(
          'select', has_table_privilege('authenticated', t.table_oid, 'SELECT'), 'insert', has_table_privilege('authenticated', t.table_oid, 'INSERT'),
          'update', has_table_privilege('authenticated', t.table_oid, 'UPDATE'), 'delete', has_table_privilege('authenticated', t.table_oid, 'DELETE'),
          'truncate', has_table_privilege('authenticated', t.table_oid, 'TRUNCATE'), 'references', has_table_privilege('authenticated', t.table_oid, 'REFERENCES'), 'trigger', has_table_privilege('authenticated', t.table_oid, 'TRIGGER')),
        'service_role', jsonb_build_object(
          'select', has_table_privilege('service_role', t.table_oid, 'SELECT'), 'insert', has_table_privilege('service_role', t.table_oid, 'INSERT'),
          'update', has_table_privilege('service_role', t.table_oid, 'UPDATE'), 'delete', has_table_privilege('service_role', t.table_oid, 'DELETE'),
          'truncate', has_table_privilege('service_role', t.table_oid, 'TRUNCATE'), 'references', has_table_privilege('service_role', t.table_oid, 'REFERENCES'), 'trigger', has_table_privilege('service_role', t.table_oid, 'TRIGGER')),
        'postgres', jsonb_build_object(
          'select', has_table_privilege('postgres', t.table_oid, 'SELECT'), 'insert', has_table_privilege('postgres', t.table_oid, 'INSERT'),
          'update', has_table_privilege('postgres', t.table_oid, 'UPDATE'), 'delete', has_table_privilege('postgres', t.table_oid, 'DELETE'),
          'truncate', has_table_privilege('postgres', t.table_oid, 'TRUNCATE'), 'references', has_table_privilege('postgres', t.table_oid, 'REFERENCES'), 'trigger', has_table_privilege('postgres', t.table_oid, 'TRIGGER'))
      )
    ) end
  ) as value from table_oids t
),
function_report as (
  select coalesce(jsonb_agg(
    case when f.function_oid is null then jsonb_build_object('name', f.function_name, 'exists', false)
    else jsonb_build_object(
      'name', f.function_name,
      'exists', true,
      'oid', p.oid,
      'identityArguments', pg_catalog.pg_get_function_identity_arguments(p.oid),
      'signature', p.oid::pg_catalog.regprocedure::text,
      'resultType', pg_catalog.pg_get_function_result(p.oid),
      'definition', pg_catalog.pg_get_functiondef(p.oid),
      'securityDefiner', p.prosecdef,
      'owner', p.proowner::pg_catalog.regrole::text,
      'searchPath', coalesce((select split_part(config_entry.setting, '=', 2) from unnest(p.proconfig) as config_entry(setting) where config_entry.setting like 'search_path=%' limit 1), '(database default)'),
      'volatility', case p.provolatile when 'i' then 'immutable' when 's' then 'stable' when 'v' then 'volatile' end,
      'privileges', jsonb_build_object(
        'PUBLIC_EXECUTE', coalesce((select bool_or(x.privilege_type = 'EXECUTE') from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) x where x.grantee = 0), false),
        'anon_EXECUTE', has_function_privilege('anon', p.oid, 'EXECUTE'),
        'authenticated_EXECUTE', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
        'service_role_EXECUTE', has_function_privilege('service_role', p.oid, 'EXECUTE'),
        'postgres_EXECUTE', has_function_privilege('postgres', p.oid, 'EXECUTE')),
      'dependents', coalesce((
        select jsonb_agg(pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid) order by d.classid::text, d.objid)
        from pg_catalog.pg_depend d where d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.refobjid = p.oid
          and d.deptype not in ('p', 'i')
      ), '[]'::jsonb),
      'referencedObjects', coalesce((
        select jsonb_agg(pg_catalog.pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid) order by d.refclassid::text, d.refobjid)
        from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.objid = p.oid
          and d.refobjid <> 0 and d.deptype not in ('p', 'i')
      ), '[]'::jsonb)
    ) end order by f.function_name, p.oid
  ), '[]'::jsonb) as value
  from function_oids f left join pg_catalog.pg_proc p on p.oid = f.function_oid
),
migration_report as (
  select case
    when pg_catalog.to_regclass('supabase_migrations.schema_migrations') is null
      then jsonb_build_object('exists', false, 'contents', null)
    else jsonb_build_object(
      'exists', true,
      'contents_xml', pg_catalog.query_to_xml(
        'select coalesce(jsonb_agg(to_jsonb(m) order by to_jsonb(m)::text), ''[]''::jsonb) as rows from supabase_migrations.schema_migrations m',
        false, true, ''
      )::text
    )
  end as value
)
select jsonb_pretty(jsonb_build_object(
  'audit', 'NODARA production catalog audit',
  'readOnly', true,
  'tables', (select value from table_report),
  'functions', (select value from function_report),
  'migrationHistory', (select value from migration_report)
)) as nodara_production_catalog_audit;
