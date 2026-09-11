-- DevScout schema. Run once against your Postgres database.
-- Idempotent: safe to re-run.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Recruiter accounts. One row per signed-up user.
CREATE TABLE IF NOT EXISTS users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  name                TEXT,
  -- Billing (synced from Stripe via webhooks).
  stripe_customer_id  TEXT UNIQUE,
  plan                TEXT NOT NULL DEFAULT 'free',          -- 'free' | 'pro'
  subscription_status TEXT NOT NULL DEFAULT 'inactive',      -- inactive|trialing|active|past_due|canceled
  current_period_end  TIMESTAMPTZ,
  -- Daily usage meter for free-tier gating.
  lookups_today       INTEGER NOT NULL DEFAULT 0,
  lookups_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A shortlisted GitHub candidate, owned by a user.
CREATE TABLE IF NOT EXISTS candidates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  login         TEXT NOT NULL,
  name          TEXT,
  avatar_url    TEXT,
  html_url      TEXT,
  bio           TEXT,
  location      TEXT,
  company       TEXT,
  followers     INTEGER DEFAULT 0,
  public_repos  INTEGER DEFAULT 0,
  summary       TEXT,
  role_fit      TEXT,
  top_languages JSONB DEFAULT '[]'::jsonb,
  signals       JSONB DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The same person can be shortlisted once per recruiter.
  UNIQUE (user_id, login)
);

CREATE TABLE IF NOT EXISTS tags (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, label)
);

CREATE TABLE IF NOT EXISTS notes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidates_user ON candidates(user_id);
CREATE INDEX IF NOT EXISTS idx_tags_candidate  ON tags(candidate_id);
CREATE INDEX IF NOT EXISTS idx_notes_candidate ON notes(candidate_id);
