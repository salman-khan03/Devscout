-- ---------------------------------------------------------------------------
-- 0001  Identity: users, organisations, membership and invitations.
--
-- The tenancy model is: a User is a person, an Org is the billing + data
-- boundary, and a Membership joins them with a role. A person can belong to
-- several orgs, which is why role never lives on the user row.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram search on logins/names

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT,
  avatar_url    TEXT,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Emails are compared case-insensitively; store them lowercased and prove it.
ALTER TABLE users ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email));

CREATE TABLE orgs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL UNIQUE,
  plan                TEXT NOT NULL DEFAULT 'free',
  subscription_status TEXT NOT NULL DEFAULT 'inactive',
  stripe_customer_id  TEXT UNIQUE,
  stripe_subscription_id TEXT,
  current_period_end  TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  seats               INTEGER NOT NULL DEFAULT 1,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT orgs_plan_valid CHECK (plan IN ('free', 'team', 'scale')),
  CONSTRAINT orgs_status_valid CHECK (
    subscription_status IN ('inactive','trialing','active','past_due','canceled','unpaid','incomplete','incomplete_expired','paused')
  ),
  CONSTRAINT orgs_slug_shape CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
);

-- Roles are ordered by power; `rank` lets permission checks be a comparison
-- rather than a set membership test scattered across the codebase.
CREATE TABLE roles (
  name TEXT PRIMARY KEY,
  rank INTEGER NOT NULL UNIQUE,
  description TEXT NOT NULL
);

INSERT INTO roles (name, rank, description) VALUES
  ('viewer',    10, 'Read-only: search, view candidates and lists.'),
  ('recruiter', 20, 'Everything a viewer can do, plus edit lists, notes, tags and saved searches.'),
  ('admin',     30, 'Manage members, invitations and ingestion.'),
  ('owner',     40, 'Full control including billing and deleting the organisation.');

CREATE TABLE memberships (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL REFERENCES roles(name),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE INDEX idx_memberships_user ON memberships(user_id);
CREATE INDEX idx_memberships_org  ON memberships(org_id);

-- An org must always have at least one owner. Enforced in application code on
-- role change / removal; this partial index makes the owner lookup trivial.
CREATE INDEX idx_memberships_owners ON memberships(org_id) WHERE role = 'owner';

CREATE TABLE invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL REFERENCES roles(name),
  -- Only the hash is stored. The raw token is shown once, to the inviter.
  token_hash  TEXT NOT NULL UNIQUE,
  invited_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live invitation per email per org; re-inviting replaces the old one.
CREATE UNIQUE INDEX idx_invites_pending ON invites(org_id, email) WHERE accepted_at IS NULL;
CREATE INDEX idx_invites_org ON invites(org_id);
