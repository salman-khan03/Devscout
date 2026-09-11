/** Shapes returned by the DevScout API. Kept in one file so a server change
 *  that breaks the contract surfaces as a type error rather than at runtime. */

export type RoleName = 'viewer' | 'recruiter' | 'admin' | 'owner';

/**
 * Every permission the API enforces, mirrored from the server's RBAC table.
 *
 * Spelled out as a union rather than `string` so a mistyped permission in a
 * `can()` call or a route guard fails to compile, instead of silently
 * evaluating false and hiding a page from everyone.
 */
export type Permission =
  | 'search:run'
  | 'candidate:view'
  | 'candidate:scan'
  | 'list:read'
  | 'list:write'
  | 'note:write'
  | 'tag:write'
  | 'savedSearch:read'
  | 'savedSearch:write'
  | 'export:csv'
  | 'analytics:read'
  | 'ingest:enqueue'
  | 'member:read'
  | 'member:invite'
  | 'member:manage'
  | 'org:update'
  | 'billing:manage'
  | 'org:delete';
export type RankMode = 'hybrid' | 'vector' | 'lexical' | 'signal';
export type SortMode = 'relevance' | 'stars' | 'followers' | 'recent';
export type Stage =
  | 'sourced'
  | 'contacted'
  | 'screening'
  | 'interview'
  | 'offer'
  | 'hired'
  | 'rejected';

export interface LanguageShare {
  language: string;
  pct: number;
  repos: number;
  stars: number;
}

export interface Signals {
  totalStars: number;
  totalForks: number;
  originalRepos: number;
  forkedRepos: number;
  archivedRepos: number;
  recentPushes: number;
  activeYears: number;
  medianRepoStars: number;
  topRepoStars: number;
  distinctLanguages: number;
  collaborationRatio: number;
  lastActiveAt: string | null;
}

export interface Evidence {
  matchedTerms: Array<{ term: string; field: 'language' | 'topic' | 'bio' | 'repo' | 'name' }>;
  reasons: string[];
  contributions: Array<{ ranker: RankMode; rank: number | null; score: number; weight: number }>;
}

export interface Candidate {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string | null;
  bio: string | null;
  location: string | null;
  company: string | null;
  followers: number;
  publicRepos: number;
  totalStars: number;
  originalRepos: number;
  recentPushes: number;
  languages: LanguageShare[];
  topics: string[];
  signals: Signals;
  seniority: string | null;
  summary: string | null;
  roleFit: string | null;
  summarySource: string;
  isSynthetic: boolean;
  lastActiveAt: string | null;
  updatedAt: string;
  score: number;
  evidence: Evidence;
}

/**
 * What "save to a pipeline" actually needs.
 *
 * A search result carries ranking evidence; a fetched profile does not. Both
 * are saveable, so the save path takes this narrow shape instead of forcing
 * the profile drawer to invent a score and an empty evidence object just to
 * satisfy the wider `Candidate`.
 */
export type SaveableCandidate = Pick<Candidate, 'id' | 'login' | 'name'> & {
  evidence?: Evidence;
};

export interface CandidateDetail extends Omit<Candidate, 'score' | 'evidence'> {
  blog: string | null;
  hireable: boolean | null;
  following: number;
  githubCreatedAt: string | null;
  activityScore: number;
  impactScore: number;
  fetchedAt: string | null;
  repos: Array<{
    name: string;
    description: string | null;
    language: string | null;
    stars: number;
    forks: number;
    topics: string[];
    html_url: string;
    pushed_at: string;
  }>;
  tags: Array<{ id: string; label: string; created_at: string }>;
  notes: Array<{
    id: string;
    body: string;
    created_at: string;
    updated_at: string;
    author_name: string | null;
  }>;
  lists: Array<{
    id: string;
    list_id: string;
    list_name: string;
    stage: Stage;
    rating: number | null;
    added_at: string;
  }>;
  source: 'corpus' | 'github';
}

export interface SearchResponse {
  results: Candidate[];
  total: number;
  tookMs: number;
  mode: RankMode;
  hasMore: boolean;
  vectorAvailable: boolean;
}

export interface FacetBucket {
  value: string;
  count: number;
}

export interface Facets {
  languages: FacetBucket[];
  topics: FacetBucket[];
  seniority: FacetBucket[];
  total: number;
}

/** The complete filter state. Mirrors the server's filter schema exactly, and
 *  is also what the URL encodes and a saved search stores. */
export interface Filters {
  q: string;
  languages: string[];
  topics: string[];
  locations: string[];
  seniority: string[];
  minFollowers?: number;
  minStars?: number;
  minRepos?: number;
  activeWithinDays?: number;
  hireable?: boolean;
  savedOnly?: boolean;
  excludeSaved?: boolean;
  mode: RankMode;
  sort: SortMode;
}

export interface PlanLimits {
  scansPerDay: number | null;
  searchesPerDay: number | null;
  savedCandidates: number | null;
  seats: number | null;
  ingestJobsPerDay: number | null;
  savedSearches: number | null;
  csvExport: boolean;
  analytics: boolean;
}

export interface Session {
  user: { id: string; email: string; name: string | null; avatar_url: string | null };
  memberships: Array<{
    orgId: string;
    slug: string;
    name: string;
    role: RoleName;
    plan: string;
  }>;
  org: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    entitledPlan: string;
    planName: string;
    subscriptionStatus: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    seats: number;
    limits: PlanLimits;
  } | null;
  role: RoleName | null;
  permissions: string[];
  usage: {
    profile_scans: number;
    searches: number;
    ingest_jobs: number;
    exports: number;
  } | null;
  features: { billing: boolean; github: boolean; llm: boolean; demoMode: boolean };
}

export interface ListSummary {
  id: string;
  name: string;
  description: string | null;
  color: string;
  is_default: boolean;
  created_at: string;
  member_count: number;
  stages: Partial<Record<Stage, number>>;
}

export interface ListMember {
  id: string;
  stage: Stage;
  rating: number | null;
  position: number;
  source_query: string | null;
  match_evidence: Record<string, unknown>;
  added_at: string;
  added_by_name: string | null;
  developer_id: string;
  login: string;
  name: string | null;
  avatar_url: string | null;
  html_url: string | null;
  bio: string | null;
  location: string | null;
  company: string | null;
  followers: number;
  total_stars: number;
  original_repos: number;
  recent_pushes: number;
  languages: LanguageShare[];
  topics: string[];
  seniority: string | null;
  role_fit: string | null;
  summary: string | null;
  is_synthetic: boolean;
  last_active_at: string | null;
  tags: string[] | null;
  note_count: number;
}

/** `GET /lists/:id`. The server sends `stages` here as the ordered set of board
 *  columns, whereas `GET /lists` sends per-stage counts under the same name -
 *  so the count field is omitted rather than widened, keeping each response
 *  typed as it actually arrives. */
export interface ListDetail extends Omit<ListSummary, 'stages'> {
  members: ListMember[];
  stages: Stage[];
}

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  filters: Partial<Filters>;
  is_shared: boolean;
  run_count: number;
  last_run_at: string | null;
  created_at: string;
  created_by_name: string | null;
}

export interface Member {
  id: string;
  role: RoleName;
  created_at: string;
  user_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  last_login_at: string | null;
}

export interface MembersResponse {
  members: Member[];
  pendingInvites: Array<{
    id: string;
    email: string;
    role: RoleName;
    expires_at: string;
    created_at: string;
  }>;
  seatsUsed: number;
  seatLimit: number;
  roles: RoleName[];
}

export interface Analytics {
  funnel: {
    viewed: number;
    shortlisted: number;
    advanced: number;
    exported: number;
    unique_candidates: number;
  };
  conversion: { viewToShortlist: number; shortlistToAdvanced: number };
  searchVolume: Array<{
    day: string;
    searches: number;
    avg_took_ms: number;
    p95_took_ms: number;
    avg_results: string;
    zero_result_searches: number;
  }>;
  topQueries: Array<{ query: string; runs: number; avg_results: number }>;
  zeroResultQueries: Array<{ query: string; runs: number }>;
  pipelineLanguages: Array<{ language: string; candidates: number }>;
  teamActivity: Array<{
    name: string | null;
    email: string;
    viewed: number;
    shortlisted: number;
    advanced: number;
  }>;
  stageBreakdown: Array<{ stage: Stage; n: number }>;
  timeline: Array<{
    day: string;
    viewed: number;
    shortlisted: number;
    staged: number;
    unique_developers: number;
    active_users: number;
  }>;
  days: number;
  usage: Session['usage'];
  limits: PlanLimits;
  queue: {
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    dead: number;
    oldestQueuedSeconds: number | null;
  };
}

export interface CompareResponse {
  profiles: CandidateDetail[];
  axes: {
    languages: string[];
    topics: string[];
    metrics: Array<{ key: string; label: string }>;
  };
}

export interface Plan {
  id: string;
  name: string;
  blurb: string;
  priceLabel: string;
  priceMonthly: number;
  trialDays: number;
  features: string[];
  limits: PlanLimits;
  purchasable: boolean;
}

export interface IngestJob {
  id: string;
  kind: string;
  target: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  finished_at: string | null;
}

export interface IngestStatus {
  corpus: {
    developers: number;
    embedded: number;
    stale_embeddings: number;
    synthetic: number;
    last_ingest: string | null;
  };
  queue: Analytics['queue'];
  github: {
    limit: number;
    remaining: number;
    resetAt: string;
    circuitOpenUntil: string | null;
  } | null;
  embeddingModel: string;
  githubConfigured: boolean;
}
