-- ---------------------------------------------------------------------------
-- 0004  Operational tables: the ingestion queue's durable state, the product
--       analytics event stream, the audit trail and the usage meters.
--
-- ingest_jobs is infrastructure, not tenant data: the worker must scan it
-- across every org, so it is not placed under RLS (see 0005 for the split).
-- ---------------------------------------------------------------------------

CREATE TABLE ingest_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID REFERENCES orgs(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,

  kind    TEXT NOT NULL,   -- 'profile' | 'discover' | 'embed' | 'refresh'
  target  TEXT NOT NULL,   -- a login, or a GitHub search query for 'discover'
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,

  status   TEXT NOT NULL DEFAULT 'queued',
  priority SMALLINT NOT NULL DEFAULT 5,   -- lower runs first
  attempts SMALLINT NOT NULL DEFAULT 0,
  max_attempts SMALLINT NOT NULL DEFAULT 4,
  last_error TEXT,
  result   JSONB,

  -- Backoff target. The worker only considers jobs whose time has come.
  run_after   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT job_kind_valid CHECK (kind IN ('profile','discover','embed','refresh')),
  CONSTRAINT job_status_valid CHECK (status IN ('queued','running','succeeded','failed','dead','skipped'))
);

-- The worker's claim query hits exactly this index.
CREATE INDEX idx_jobs_claimable ON ingest_jobs(status, priority, run_after)
  WHERE status = 'queued';
CREATE INDEX idx_jobs_org ON ingest_jobs(org_id, created_at DESC);
CREATE INDEX idx_jobs_status ON ingest_jobs(status, created_at DESC);

-- Collapses duplicate work: one live job per (kind, target). A second request
-- to scan the same developer while one is pending is a no-op rather than a
-- second spend of the GitHub budget.
CREATE UNIQUE INDEX idx_jobs_dedupe ON ingest_jobs(kind, target)
  WHERE status IN ('queued','running');

-- Product analytics. Append-only; every row is one thing a user did.
CREATE TABLE search_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  query        TEXT NOT NULL DEFAULT '',
  filters      JSONB NOT NULL DEFAULT '{}'::jsonb,
  mode         TEXT NOT NULL DEFAULT 'hybrid',
  result_count INTEGER NOT NULL DEFAULT 0,
  took_ms      INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_search_events_org ON search_events(org_id, created_at DESC);
CREATE INDEX idx_search_events_query ON search_events(org_id, lower(query));

-- The funnel: which developers an org viewed, saved, contacted.
CREATE TABLE activity_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  developer_id UUID REFERENCES developers(id) ON DELETE CASCADE,
  action       TEXT NOT NULL,  -- viewed | shortlisted | staged | noted | tagged | compared | exported
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_activity_org ON activity_events(org_id, created_at DESC);
CREATE INDEX idx_activity_action ON activity_events(org_id, action, created_at DESC);

-- Security audit trail: who changed what, separate from product analytics
-- because it answers a different question and has a different retention need.
CREATE TABLE audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_org ON audit_log(org_id, created_at DESC);

-- Plan metering. One row per org per day keeps the counter update a single
-- upsert and makes "usage over time" a plain range scan.
CREATE TABLE usage_counters (
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  day           DATE NOT NULL DEFAULT CURRENT_DATE,
  profile_scans INTEGER NOT NULL DEFAULT 0,
  searches      INTEGER NOT NULL DEFAULT 0,
  ingest_jobs   INTEGER NOT NULL DEFAULT 0,
  exports       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, day)
);

-- Stripe delivers webhooks at least once. Recording every processed event id
-- makes replays and retries idempotent instead of double-applying a change.
CREATE TABLE stripe_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
