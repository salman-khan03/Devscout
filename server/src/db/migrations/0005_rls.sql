-- ---------------------------------------------------------------------------
-- 0005  Row-level security: the tenant isolation backstop.
--
-- Application code already writes `WHERE org_id = $1` everywhere. RLS exists
-- because "everywhere" is a claim that decays as a codebase grows. With these
-- policies a query that forgets its tenant predicate returns zero rows instead
-- of another customer's data, and the failure is loud and local.
--
-- WHAT IS COVERED: the tenant data tables. Every one of them is reached only
-- through `asTenant()` (db/pool.ts), which opens a transaction and sets
-- `app.org_id` before running anything.
--
-- WHAT IS DELIBERATELY NOT COVERED, and why:
--   orgs, memberships, invites - their access patterns are inherently
--   cross-tenant. "Which orgs does this user belong to?" and "which org does
--   this invite token belong to?" must resolve before any tenant context
--   exists, so a policy keyed on app.org_id could never be satisfied. These
--   are guarded by explicit predicates plus the authorisation layer instead.
--
--   developers, developer_repos - a shared public corpus, intentionally global.
--
--   ingest_jobs - infrastructure. The worker scans it across all orgs.
-- ---------------------------------------------------------------------------

-- Resolves the current tenant, or NULL when no context is set. A NULL makes
-- `org_id = current_org()` evaluate to NULL, which RLS treats as "deny", so
-- forgetting to open a tenant transaction fails closed.
CREATE OR REPLACE FUNCTION current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'lists', 'list_members', 'notes', 'tags', 'saved_searches',
    'search_events', 'activity_events', 'audit_log', 'usage_counters'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- Without FORCE, the table owner bypasses RLS entirely - and the
    -- application connects as the owner, which would make all of this
    -- decorative. FORCE applies the policies to the owner too.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = current_org()) WITH CHECK (org_id = current_org())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;
