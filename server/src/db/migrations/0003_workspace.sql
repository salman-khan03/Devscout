-- ---------------------------------------------------------------------------
-- 0003  Tenant workspace: everything an org creates on top of the corpus.
--
-- Every table here carries org_id as the first column of its primary access
-- path, and every one of them is placed under row-level security in 0005.
-- ---------------------------------------------------------------------------

-- A list is a pipeline: candidates move through stages inside it.
CREATE TABLE lists (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  color       TEXT NOT NULL DEFAULT 'indigo',
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE INDEX idx_lists_org ON lists(org_id);
-- Exactly one default list per org, enforced by the database rather than by
-- hoping every write path remembers to clear the previous default.
CREATE UNIQUE INDEX idx_lists_one_default ON lists(org_id) WHERE is_default;

CREATE TABLE list_members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  list_id      UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  developer_id UUID NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  stage        TEXT NOT NULL DEFAULT 'sourced',
  rating       SMALLINT,
  position     INTEGER NOT NULL DEFAULT 0,
  -- Why this person surfaced: the query and evidence at the moment of saving.
  source_query TEXT,
  match_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  added_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (list_id, developer_id),
  CONSTRAINT stage_valid CHECK (stage IN ('sourced','contacted','screening','interview','offer','hired','rejected')),
  CONSTRAINT rating_range CHECK (rating IS NULL OR rating BETWEEN 1 AND 5)
);

CREATE INDEX idx_list_members_list ON list_members(list_id, stage, position);
CREATE INDEX idx_list_members_org ON list_members(org_id);
CREATE INDEX idx_list_members_dev ON list_members(org_id, developer_id);

CREATE TABLE notes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  developer_id UUID NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  author_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notes_dev ON notes(org_id, developer_id, created_at DESC);

CREATE TABLE tags (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  developer_id UUID NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, developer_id, label)
);

CREATE INDEX idx_tags_dev ON tags(org_id, developer_id);
CREATE INDEX idx_tags_label ON tags(org_id, label);

-- A saved search stores the whole filter object, so restoring one reproduces
-- the exact result set - including ranking weights.
CREATE TABLE saved_searches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  query       TEXT NOT NULL DEFAULT '',
  filters     JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_shared   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  last_run_at TIMESTAMPTZ,
  run_count   INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE INDEX idx_saved_searches_org ON saved_searches(org_id, created_at DESC);

CREATE TRIGGER lists_touch BEFORE UPDATE ON lists
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER list_members_touch BEFORE UPDATE ON list_members
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER notes_touch BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
