-- ---------------------------------------------------------------------------
-- 0002  The developer corpus.
--
-- Deliberately NOT tenant-scoped. A GitHub profile is public fact, and one
-- shared corpus means the expensive part - fetching, analysing and embedding a
-- developer - is paid once across all tenants instead of once per tenant.
-- Everything a tenant adds on top (lists, notes, tags) lives in 0003 and is
-- strictly isolated there.
-- ---------------------------------------------------------------------------

-- pgvector supplies the `vector` type and the ANN index types. Available on
-- Neon, Supabase, RDS and the pgvector/pgvector Docker image used locally.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE developers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  login         TEXT NOT NULL UNIQUE,
  github_id     BIGINT UNIQUE,

  -- Profile facts, mirrored from the GitHub API.
  name          TEXT,
  avatar_url    TEXT,
  html_url      TEXT,
  bio           TEXT,
  location      TEXT,
  company       TEXT,
  blog          TEXT,
  email         TEXT,
  hireable      BOOLEAN,
  followers     INTEGER NOT NULL DEFAULT 0,
  following     INTEGER NOT NULL DEFAULT 0,
  public_repos  INTEGER NOT NULL DEFAULT 0,
  github_created_at TIMESTAMPTZ,

  -- Derived analysis. `languages` is [{language, pct, repos, stars}], `topics`
  -- is a ranked string array, `signals` holds the raw counters the score and
  -- the evidence explanations are both computed from.
  languages     JSONB NOT NULL DEFAULT '[]'::jsonb,
  topics        JSONB NOT NULL DEFAULT '[]'::jsonb,
  signals       JSONB NOT NULL DEFAULT '{}'::jsonb,

  total_stars    INTEGER NOT NULL DEFAULT 0,
  total_forks    INTEGER NOT NULL DEFAULT 0,
  original_repos INTEGER NOT NULL DEFAULT 0,
  recent_pushes  INTEGER NOT NULL DEFAULT 0,
  last_active_at TIMESTAMPTZ,

  -- 0..1 prior used as the third ranker. Recomputed on every ingest.
  activity_score  REAL NOT NULL DEFAULT 0,
  impact_score    REAL NOT NULL DEFAULT 0,
  seniority       TEXT,

  summary   TEXT,
  role_fit  TEXT,
  summary_source TEXT NOT NULL DEFAULT 'heuristic',  -- 'llm' | 'heuristic'

  -- Flattened text kept alongside the JSONB purely so the tsvector below can
  -- be a STORED generated column (generated expressions must be IMMUTABLE,
  -- which rules out unnesting JSONB inline).
  languages_text TEXT NOT NULL DEFAULT '',
  topics_text    TEXT NOT NULL DEFAULT '',
  repo_text      TEXT NOT NULL DEFAULT '',

  -- Weighted lexical document. A > B > C > D maps to: who they are, what they
  -- work in, how they describe themselves, what their repos say.
  search_document tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(login, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(languages_text, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(topics_text, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(bio, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(company, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(repo_text, '')), 'D')
  ) STORED,

  -- 256 dimensions for both providers: OpenAI text-embedding-3-small is asked
  -- for 256 explicitly, and the built-in local embedder emits 256. The model
  -- that produced a vector is recorded so searches never compare vectors
  -- across embedding spaces (see the WHERE clause in the ranking SQL).
  embedding       vector(256),
  embedding_model TEXT,

  -- Synthetic rows come from `npm run seed` when no GITHUB_TOKEN is present.
  -- Flagged so the UI can label demo data rather than pass it off as real.
  is_synthetic  BOOLEAN NOT NULL DEFAULT false,

  fetched_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE developer_repos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_id  UUID NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  language      TEXT,
  stars         INTEGER NOT NULL DEFAULT 0,
  forks         INTEGER NOT NULL DEFAULT 0,
  topics        JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_fork       BOOLEAN NOT NULL DEFAULT false,
  html_url      TEXT,
  pushed_at     TIMESTAMPTZ,
  UNIQUE (developer_id, name)
);

CREATE INDEX idx_repos_developer ON developer_repos(developer_id);
CREATE INDEX idx_repos_stars ON developer_repos(developer_id, stars DESC);

-- Lexical retrieval.
CREATE INDEX idx_dev_fts ON developers USING gin(search_document);
-- Fuzzy handle lookup for the "did you mean" path and @mention style search.
CREATE INDEX idx_dev_login_trgm ON developers USING gin(login gin_trgm_ops);

-- Filter predicates. Partial/expression indexes matched to the actual filters
-- the search endpoint exposes.
CREATE INDEX idx_dev_followers ON developers(followers DESC);
CREATE INDEX idx_dev_stars ON developers(total_stars DESC);
CREATE INDEX idx_dev_activity ON developers(activity_score DESC);
CREATE INDEX idx_dev_location ON developers USING gin(lower(location) gin_trgm_ops);
CREATE INDEX idx_dev_languages ON developers USING gin(languages jsonb_path_ops);
CREATE INDEX idx_dev_topics ON developers USING gin(topics jsonb_path_ops);
CREATE INDEX idx_dev_seniority ON developers(seniority);
CREATE INDEX idx_dev_updated ON developers(updated_at DESC);

-- Vector retrieval. HNSW beats IVFFlat for recall at this corpus size and,
-- unlike IVFFlat, needs no training pass before it is useful - which matters
-- because the index exists before the first row is ingested.
CREATE INDEX idx_dev_embedding ON developers
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER developers_touch
  BEFORE UPDATE ON developers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
