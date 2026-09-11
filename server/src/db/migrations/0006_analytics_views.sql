-- ---------------------------------------------------------------------------
-- 0006  Reporting helpers.
--
-- The sourcing funnel is the one analytic every query in the dashboard builds
-- on, so it lives in the database as a view rather than being reassembled in
-- TypeScript. The view reads RLS-protected tables, so it must run with the
-- caller's privileges - security_invoker makes the policies apply to whoever
-- selects from it, which is what keeps one org's funnel out of another's.
-- ---------------------------------------------------------------------------

CREATE VIEW org_funnel_daily
WITH (security_invoker = true) AS
SELECT
  org_id,
  date_trunc('day', created_at)::date AS day,
  count(*) FILTER (WHERE action = 'viewed')      AS viewed,
  count(*) FILTER (WHERE action = 'shortlisted') AS shortlisted,
  count(*) FILTER (WHERE action = 'staged')      AS staged,
  count(*) FILTER (WHERE action = 'exported')    AS exported,
  count(DISTINCT developer_id)                   AS unique_developers,
  count(DISTINCT user_id)                        AS active_users
FROM activity_events
GROUP BY org_id, date_trunc('day', created_at)::date;

CREATE VIEW org_search_daily
WITH (security_invoker = true) AS
SELECT
  org_id,
  date_trunc('day', created_at)::date AS day,
  count(*)                            AS searches,
  avg(took_ms)::int                   AS avg_took_ms,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY took_ms)::int AS p95_took_ms,
  avg(result_count)::numeric(10,2)    AS avg_results,
  count(*) FILTER (WHERE result_count = 0) AS zero_result_searches
FROM search_events
GROUP BY org_id, date_trunc('day', created_at)::date;
