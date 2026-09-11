-- ---------------------------------------------------------------------------
-- 0007  A least-privilege role for tenant queries.
--
-- WHY THIS EXISTS. Migration 0005 enabled row-level security with FORCE, which
-- makes policies apply to a table's owner. It does NOT make them apply to a
-- superuser - superusers bypass RLS unconditionally. Local Docker Postgres and
-- plenty of managed setups hand you a superuser as the application account, so
-- without this migration every policy in 0005 is decorative and a missing
-- `WHERE org_id = ...` leaks data across tenants. That failure is silent: the
-- queries succeed and simply return too many rows.
--
-- THE FIX. A NOLOGIN role that owns nothing and is not a superuser. Tenant
-- transactions `SET LOCAL ROLE devscout_app` (see asTenant in db/pool.ts), so
-- they execute with an identity that RLS genuinely constrains, then revert at
-- COMMIT. Migrations and the ingestion worker keep running as the connecting
-- user, which is what lets them touch global and infrastructure tables.
--
-- db/verify.ts asserts at boot that this is actually in force, so the silent
-- failure above cannot come back.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'devscout_app') THEN
    CREATE ROLE devscout_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO devscout_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO devscout_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO devscout_app;

-- Tables added by later migrations inherit the same grants automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO devscout_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO devscout_app;

-- The connecting user must be a member of the role to SET ROLE into it. It
-- just created the role, so it holds ADMIN OPTION and may grant it onward.
DO $$
BEGIN
  EXECUTE format('GRANT devscout_app TO %I', current_user);
EXCEPTION WHEN duplicate_object OR insufficient_privilege THEN
  -- Already a member, or a managed platform that grants membership itself.
  NULL;
END $$;
