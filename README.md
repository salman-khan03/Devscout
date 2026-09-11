# DevScout

**Developer talent intelligence.** A multi-tenant SaaS for sourcing engineers from
GitHub by the work they have actually shipped — hybrid vector + lexical + signal
ranking, with an evidence trail behind every result.

Recruiters describe the engineer they need in prose ("rust systems programmer
shipping async runtimes"), get a ranked shortlist with a checkable reason for each
match, and move candidates through a pipeline their whole team shares.

```
TypeScript · React 18 + Vite + Tailwind · Node/Express · PostgreSQL + pgvector
Redis (optional) · Stripe · Prometheus · Vitest
```

---

## What is actually interesting here

### 1. Hybrid ranking, measured rather than asserted

Three independent rankers score every candidate, and their ranked lists are fused
by reciprocal rank fusion:

| Ranker | What it knows |
|---|---|
| **vector** | 256-dim embedding similarity over a profile document — catches "async runtimes" matching a Tokio contributor who never wrote the word |
| **lexical** | Postgres `tsvector` with weighted fields (`login`/`name` > languages/topics > bio > repo text) — exact on `language:go` |
| **signal** | A computed 0..1 prior from activity and impact: fork-excluded language share, damped stars, recency-weighted work |

`npm run eval` scores all four modes against 18 hand-labelled queries and prints:

```
mode      P@10    R@50    MRR     nDCG@10  latency  zero
--------- ------- ------- ------- -------- -------- -----
lexical   58.1%   36.3%   0.611   0.509    5ms      7
vector    78.9%   69.9%   0.857   0.792    8ms      0
signal    15.6%   16.0%   0.282   0.150    6ms      0
hybrid    79.4%   71.2%   0.951   0.822    9ms      0

  P@10 on explicit    queries:  lexical 93.1%  vector 96.3%  hybrid 96.3%
  P@10 on descriptive queries:  lexical 30.0%  vector 65.0%  hybrid 66.0%
```

The split at the bottom is the whole argument for hybrid: lexical search is
excellent when the recruiter already knows the stack (93% P@10) and falls apart
when they describe the work instead (30%). Fusion keeps the former and fixes the
latter, and it answers every query — lexical returned nothing at all for 7 of 18.

> Relevance is labelled by synthetic archetype, so these numbers compare ranking
> modes fairly against each other. They are **not** a claim about real-world
> precision on real profiles.

### 2. Evidence, not vibes

Every result carries the reason it surfaced, quoted from verifiable profile facts,
plus each ranker's contribution:

```json
{
  "login": "demo-pablo-kowa",
  "score": 0.0138,
  "evidence": {
    "reasons": [
      "66.5% of their public work is Rust across 13 repos",
      "Tags repositories with \"systems-programming\""
    ],
    "contributions": [{ "ranker": "vector", "rank": 3, "weight": 0.85 }]
  }
}
```

A generated sentence about someone's seniority would be a guess. A language share
computed from their non-fork repositories is a fact a recruiter can click through
and check — so that is what the UI shows. Where an LLM *is* used (profile
summaries), the interface says so, and a heuristic fallback runs when no API key
is configured.

### 3. Tenant isolation enforced by the database

Every tenant-scoped query runs through `asTenant()`, which pins the connection to
one org and lets Postgres row-level security do the enforcement. Query predicates
are kept as well — either alone would be sufficient, so a mistake in one is caught
by the other.

The tests assert the property rather than the implementation:

- *"hides another tenant's rows even from a query with NO org predicate"*
- *"fails closed inside a tenant transaction that sets no org"*
- *"refuses to write a row belonging to another tenant"*

The server verifies its own isolation at boot and refuses to start if RLS is not
actually in force.

### 4. RBAC as a ladder, with escalation guards

Four roles (`viewer` → `recruiter` → `admin` → `owner`) and 18 permissions, mapped
in one table that both the API and the UI read — the client hides what you cannot
do, and the API rejects it anyway if you try. Nobody can grant a role above their
own or edit a peer at their own rank, which is what stops an admin promoting
themselves to owner.

### 5. Ingestion as a queue, not a request

GitHub work costs several API calls against a shared hourly rate limit, so an HTTP
handler is the wrong place to wait for it.

Job state lives in **Postgres**, not Redis. Workers claim rows with `FOR UPDATE
SKIP LOCKED`: the claim is atomic, a locked row is skipped rather than waited on,
and a worker that dies mid-job leaves a row the reaper returns to the queue — a
Redis list would have lost those in-flight jobs on a crash. Deduplication is a
partial unique index on `(kind, target) WHERE status IN ('queued','running')`, so
two requests racing to scan the same developer cannot both win.

Redis, when present, carries only a wake-up signal so a new job starts in
milliseconds instead of waiting out the poll interval. Drop it and the queue still
works, just with more latency.

On top of that: exponential backoff with jitter, dead-lettering after the attempt
budget, a circuit breaker that opens when GitHub starts failing, and remaining
rate-limit headroom visible in the UI.

### 6. A frontend built like a tool

- **URL-owned filter state** — a search is a link. Back steps through filter
  changes, a reload restores your work, and a saved search and a shared URL are
  the same object, so they cannot drift apart.
- **Virtualised infinite list** — the fusion pool returns up to 500 candidates;
  only the visible window is mounted. The infinite-scroll sentinel lives *outside*
  the virtualised container, because inside it would be unmounted most of the time
  and never fire.
- **Optimistic saving** — bookmarks fill in immediately and roll back on failure,
  with the plan-limit case (402) surfacing as an upgrade offer rather than an error.
- **Keyboard navigation** — `/` focuses search, `j`/`k` move, `s` saves, `c`
  compares. Roving focus with `aria-activedescendant` keeps the tab order one stop
  long no matter how many results are loaded.
- **Accessibility as a constraint** — focus traps that restore focus on close, live
  regions announcing result counts, real labels everywhere, visible focus rings,
  and `prefers-reduced-motion` respected.
- **Theming** — semantic tokens defined once per mode, so no component carries a
  `dark:` variant. Chart series use a separate palette validated for
  colour-vision separation and re-stepped for the dark surface.

---

## Quick start

Needs Node 20+ and Docker.

```bash
npm install
docker compose up -d          # Postgres 16 + pgvector, Redis 7

cp server/.env.example server/.env
# Set JWT_SECRET — the server refuses to boot without it:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

npm run migrate               # 7 migrations, idempotent
npm run seed                   # 320 synthetic profiles, labelled as demo data
npm run dev                    # api :4000 · web :5173 · worker
```

Sign up at http://localhost:5173 and the first account creates its own workspace.

**Nothing above needs an API key.** With no `GITHUB_TOKEN` the app searches the
seeded corpus; with no `OPENROUTER_API_KEY` summaries come from the heuristic; with
no Stripe keys billing is hidden entirely. Each optional capability is reported at
boot and on the Ingestion page, so what is switched on is never a mystery.

To search real people instead, set `GITHUB_TOKEN` and use the Ingestion page to
queue a profile or a discovery query.

## Verifying it

```bash
npm run typecheck    # strict TypeScript, both workspaces
npm run lint         # ESLint, zero warnings allowed
npm test             # 58 tests across queue, ranking, RBAC, security, tenancy
npm run eval         # the retrieval table above
npm run build        # server tsc + web production bundle
```

The test suite runs against real Postgres and Redis rather than mocks — the
isolation guarantees it checks only mean something against an actual database.

## Layout

```
server/
  src/db/          pool with asTenant(), migrations, RLS policies
  src/lib/         auth, rbac, queue, ratelimit, cache, plans, metrics
  src/services/    ranking, embeddings, corpus, ingestion, github, llm, stripe
  src/routes/      auth, orgs, search, candidates, lists, savedSearches,
                   analytics, ingest, billing, export, system
  src/eval/        labelled queries + the scoring harness
  test/            queue, ranking, rbac, security, tenancy
web/
  src/components/  results, filters, drawer, compare, charts, design system
  src/hooks/       URL filter state, hotkeys, focus trap, virtualisation helpers
  src/pages/       search, pipelines, analytics, team, ingestion, account, pricing
```

## API

```
POST   /api/auth/register | login | logout | switch-org | change-password
GET    /api/auth/session | /plans

GET    /api/search?q=&languages=&mode=&sort=&offset=&limit=
GET    /api/search/facets | /suggest
GET    /api/candidates/:login | /api/candidates?logins=a,b
POST   /api/candidates/:login/refresh

GET    /api/lists | /api/lists/:id                      POST /api/lists
POST   /api/lists/:id/members                           PATCH /api/lists/:id/members/:memberId
POST   /api/lists/notes/:developerId | /tags/:developerId

GET    /api/saved-searches                              POST /api/saved-searches/:id/run
GET    /api/orgs/members | /audit                       POST /api/orgs/invites
GET    /api/analytics?days=30                           (Team plan and up)
GET    /api/ingest/status | /jobs                       POST /api/ingest/profile | /discover
POST   /api/billing/checkout | /portal | /webhook
GET    /api/export/csv                                  (Team plan and up)
GET    /api/health · /metrics                           (Prometheus)
```

Errors are JSON with a stable `code` (`not_found`, `conflict`, `plan_limit`,
`forbidden`), and every response carries a correlatable request id.

## Plans

Limits live in `server/src/lib/plans.ts` — one definition drives gating, the
pricing page and the usage meters.

| | Free | Team | Scale |
|---|---|---|---|
| Searches / day | 100 | 2,000 | unlimited |
| Profile scans / day | 25 | 500 | unlimited |
| Saved candidates | 50 | 2,500 | unlimited |
| Seats | 1 | 8 | 50 |
| Saved searches | 3 | 50 | unlimited |
| CSV export | — | ✓ | ✓ |
| Analytics | — | ✓ | ✓ |

Exceeding a limit returns **402** with the feature and plan in `details`, which the
UI turns into an upgrade prompt rather than an error.

## Security

- bcrypt at cost 12; login answers identically for an unknown email and a wrong
  password, so accounts cannot be enumerated.
- Session JWT in an httpOnly, SameSite cookie — unreadable by script, so there is
  no token in `localStorage` for an XSS to steal.
- `helmet` with CSP and framing denied, body-size caps, and per-name rate limits
  (Redis-backed when available) on auth, search and profile endpoints.
- The Stripe webhook verifies its signature against the raw body; the global JSON
  parser is skipped for exactly that route.
- Row-level security on every tenant table, verified at boot and in tests.

## Known limitations

- **Email is not wired up.** Invitations produce a link copied to your clipboard
  rather than a sent message; password reset is therefore not implemented.
- **The seeded corpus is synthetic** and labelled as demo data everywhere it
  appears. Eval numbers compare rankers, not real-world precision.
- **The local embedder is a hashed bag-of-features**, chosen so the project runs
  offline. It is beaten by a real embedding model; set
  `EMBEDDING_PROVIDER=openai` and re-embed for that.
- **Stage moves use a select, not drag-and-drop** — deliberate, since it works by
  keyboard, screen reader and touch, but a mouse-first user would find dragging
  faster.
- **No public API tier.** The queue does prioritise work (interactive lookups
  ahead of bulk discovery and embedding), but that ordering is by job kind, not
  by plan, and no plan advertises either as a feature.

## Render + Neon deployment

See [deployment instructions](docs/RENDER.md) and [render.yaml](render.yaml).
Gemini summaries use the native Google API, with server-only GEMINI_API_KEY and
GEMINI_MODEL configuration. The default model is gemini-3.6-flash; unsuccessful
requests fall back to deterministic summaries. Neon uses pooled runtime connections
and DIRECT_DATABASE_URL for migration locks.
