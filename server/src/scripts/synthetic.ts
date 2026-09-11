import type { GithubUser, GithubRepo } from '../services/github.js';

/**
 * A deterministic synthetic developer corpus.
 *
 * WHY THIS EXISTS. Ingesting real profiles needs a GitHub token and burns
 * quota, so a fresh clone would otherwise open onto an empty product. This
 * generates a coherent corpus offline in about a second, which makes
 * `npm run setup` end at a working demo.
 *
 * HONESTY. Every row it writes is flagged `is_synthetic = true`, and the UI
 * labels those profiles as demo data. These are invented people. They are not
 * presented as real engineers anywhere in the product, and pointing DevScout at
 * a real GitHub token replaces them with real ones.
 *
 * DETERMINISM. A seeded PRNG means the same corpus every run, which is what
 * lets src/eval hold a hand-labelled relevance set against it and report a
 * Precision@10 that means something across machines.
 */

/** mulberry32 - small, fast, and stable across Node versions. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Archetype {
  key: string;
  /** Primary language first; share decays down the list. */
  languages: string[];
  topics: string[];
  bios: string[];
  repoNames: string[];
  repoBlurbs: string[];
  roles: string[];
}

/**
 * Archetypes give the corpus internal consistency: a Rust systems person has
 * Rust repos with systems topics and a systems-sounding bio. Without that,
 * semantic search has nothing real to find and the demo proves nothing.
 */
const ARCHETYPES: Archetype[] = [
  {
    key: 'rust-systems',
    languages: ['Rust', 'C', 'C++', 'Shell'],
    topics: ['systems-programming', 'async', 'tokio', 'wasm', 'performance', 'memory-safety', 'compilers'],
    bios: [
      'Systems engineer. Async runtimes, zero-copy parsers, and making things not allocate.',
      'Writing Rust for storage engines. Interested in lock-free data structures and io_uring.',
      'Compiler and runtime work in Rust. Previously C++ on embedded targets.',
      'Low-level performance work. Benchmarks or it did not happen.',
    ],
    repoNames: ['tokio-shard', 'zerocopy-proto', 'rust-lsm', 'wasm-runtime', 'alloc-profiler', 'io-uring-net', 'lockfree-queue'],
    repoBlurbs: [
      'A log-structured merge tree written in safe Rust',
      'Zero-copy protocol parser with no heap allocation on the hot path',
      'Minimal WebAssembly runtime with a JIT tier',
      'Lock-free MPMC queue benchmarked against crossbeam',
      'Async networking layer built directly on io_uring',
    ],
    roles: ['Systems engineer', 'Infrastructure engineer', 'Performance engineer'],
  },
  {
    key: 'ml-python',
    languages: ['Python', 'Jupyter Notebook', 'C++', 'Cuda'],
    topics: ['machine-learning', 'deep-learning', 'pytorch', 'nlp', 'transformers', 'llm', 'inference', 'rag'],
    bios: [
      'ML engineer working on retrieval and ranking. PyTorch, vector search, evaluation harnesses.',
      'Training and serving transformer models. Care a lot about evaluation, less about leaderboards.',
      'NLP research turned production. Embeddings, reranking, and inference latency.',
      'Applied ML. Mostly making models small enough to actually deploy.',
    ],
    repoNames: ['torch-rerank', 'embed-bench', 'tiny-llm', 'rag-eval', 'quantize-kit', 'attention-viz', 'vector-index'],
    repoBlurbs: [
      'Benchmarking harness for embedding models on retrieval tasks',
      'Cross-encoder reranker with a distillation pipeline',
      'Post-training quantisation toolkit for transformer inference',
      'Evaluation suite for retrieval-augmented generation systems',
      'Approximate nearest neighbour index with a Python binding',
    ],
    roles: ['Machine learning engineer', 'Research engineer', 'Applied scientist'],
  },
  {
    key: 'frontend-react',
    languages: ['TypeScript', 'JavaScript', 'CSS', 'HTML'],
    topics: ['react', 'typescript', 'accessibility', 'design-systems', 'animation', 'webgl', 'performance'],
    bios: [
      'Front-end engineer. Design systems, accessibility, and interfaces that stay fast under real data.',
      'React and TypeScript. I care about keyboard navigation and the 95th percentile render.',
      'Building component libraries and the tooling around them. WCAG is a floor, not a goal.',
      'Interaction design and WebGL. Motion with intent.',
    ],
    repoNames: ['headless-ui-kit', 'virtual-table', 'a11y-lint', 'motion-primitives', 'ts-forms', 'webgl-scenes', 'css-reset-modern'],
    repoBlurbs: [
      'Virtualised data table that stays at 60fps with 100k rows',
      'Accessible headless component primitives with full keyboard support',
      'Lint rules that catch accessibility regressions in JSX',
      'Composable animation primitives that respect prefers-reduced-motion',
      'Type-safe form state without a re-render on every keystroke',
    ],
    roles: ['Frontend engineer', 'UI engineer', 'Design engineer'],
  },
  {
    key: 'go-infra',
    languages: ['Go', 'Shell', 'Makefile', 'Python'],
    topics: ['kubernetes', 'distributed-systems', 'grpc', 'observability', 'microservices', 'cloud-native', 'etcd'],
    bios: [
      'Backend engineer. Distributed systems in Go, mostly consensus and the boring parts of reliability.',
      'Platform engineering. Kubernetes operators, gRPC services, and useful dashboards.',
      'Go and Postgres. I like systems that degrade gracefully.',
      'Infrastructure engineer working on service mesh and observability tooling.',
    ],
    repoNames: ['raft-kv', 'k8s-operator-sdk', 'grpc-gateway-ext', 'otel-collector-ext', 'consistent-hash', 'leaderelect', 'chaos-probe'],
    repoBlurbs: [
      'Raft-backed key-value store with linearisable reads',
      'Kubernetes operator scaffolding with generated CRDs',
      'OpenTelemetry collector extension for per-tenant metrics',
      'Consistent hashing library with bounded load',
      'Fault injection harness for distributed integration tests',
    ],
    roles: ['Backend engineer', 'Platform engineer', 'Distributed systems engineer'],
  },
  {
    key: 'devops-cloud',
    languages: ['HCL', 'Python', 'Go', 'Shell'],
    topics: ['terraform', 'aws', 'ci-cd', 'docker', 'infrastructure-as-code', 'sre', 'monitoring'],
    bios: [
      'SRE. Terraform, incident response, and deleting YAML wherever possible.',
      'Platform and reliability. I automate the thing rather than document the thing.',
      'Cloud infrastructure at scale. Cost, reliability, and blast radius.',
      'DevOps engineer. Pipelines, provisioning, and paging myself less each quarter.',
    ],
    repoNames: ['tf-modules-aws', 'ci-cache-action', 'drift-detect', 'cost-explorer-cli', 'runbook-gen', 'slo-calculator', 'docker-slim-build'],
    repoBlurbs: [
      'Reusable Terraform modules for multi-account AWS setups',
      'Detects infrastructure drift between state and reality',
      'CLI that attributes cloud spend to teams and services',
      'SLO and error-budget calculator that reads from Prometheus',
      'Build pipeline that produces minimal container images',
    ],
    roles: ['Site reliability engineer', 'DevOps engineer', 'Cloud infrastructure engineer'],
  },
  {
    key: 'mobile',
    languages: ['Swift', 'Kotlin', 'Dart', 'Objective-C'],
    topics: ['ios', 'android', 'swiftui', 'jetpack-compose', 'mobile', 'offline-first', 'flutter'],
    bios: [
      'iOS engineer. SwiftUI, offline-first sync, and app launch time.',
      'Android developer working in Kotlin and Compose. Accessibility and battery matter.',
      'Cross-platform mobile. Flutter, with native modules where it counts.',
      'Mobile engineer. I optimise for the phone someone actually owns.',
    ],
    repoNames: ['swiftui-charts', 'compose-motion', 'offline-sync', 'mobile-perf-kit', 'kotlin-result', 'flutter-widgets', 'ios-keychain'],
    repoBlurbs: [
      'Declarative charting components for SwiftUI',
      'Offline-first sync engine with conflict resolution',
      'Launch-time profiling toolkit for iOS applications',
      'Jetpack Compose motion and gesture primitives',
      'Typed result and error handling utilities for Kotlin',
    ],
    roles: ['iOS engineer', 'Android engineer', 'Mobile engineer'],
  },
  {
    key: 'data-eng',
    languages: ['Python', 'SQL', 'Scala', 'Java'],
    topics: ['data-engineering', 'spark', 'airflow', 'etl', 'data-warehouse', 'streaming', 'kafka', 'dbt'],
    bios: [
      'Data engineer. Streaming pipelines, Kafka, and schemas that survive contact with reality.',
      'Building batch and streaming ETL. Spark, Airflow, and a lot of dbt.',
      'Analytics engineering. I make the warehouse trustworthy.',
      'Data platform engineer. Lineage, quality checks, and backfills that finish.',
    ],
    repoNames: ['airflow-operators', 'kafka-schema-guard', 'dbt-audit', 'spark-tuner', 'lineage-graph', 'cdc-connector', 'warehouse-tests'],
    repoBlurbs: [
      'Schema compatibility checks enforced in the Kafka produce path',
      'Column-level lineage extracted from warehouse query logs',
      'Data quality assertions that run as part of the dbt build',
      'Change data capture connector with exactly-once delivery',
      'Airflow operators for idempotent, resumable backfills',
    ],
    roles: ['Data engineer', 'Analytics engineer', 'Data platform engineer'],
  },
  {
    key: 'security',
    languages: ['Python', 'Go', 'C', 'Rust'],
    topics: ['security', 'cryptography', 'appsec', 'fuzzing', 'reverse-engineering', 'sast', 'supply-chain'],
    bios: [
      'Application security. Fuzzing, static analysis, and supply chain integrity.',
      'Security engineer. I read other people parsers for a living.',
      'Cryptography engineering and protocol review. Constant-time or bust.',
      'Offensive security turned defensive tooling. Threat modelling and SAST.',
    ],
    repoNames: ['fuzz-corpus', 'sbom-verify', 'const-time-cmp', 'sast-rules', 'tls-probe', 'secret-scanner', 'dep-audit'],
    repoBlurbs: [
      'Coverage-guided fuzzing harnesses for common parsers',
      'Verifies software bill of materials against build provenance',
      'Static analysis rules for common authorisation mistakes',
      'Scans repository history for committed credentials',
      'TLS configuration prober with a scoring report',
    ],
    roles: ['Security engineer', 'Application security engineer', 'Security researcher'],
  },
];

const FIRST = [
  'ada', 'kai', 'nadia', 'tobias', 'lena', 'omar', 'priya', 'jonas', 'mira', 'theo',
  'yuki', 'sofia', 'marcus', 'elena', 'raj', 'anya', 'felix', 'ines', 'diego', 'hana',
  'noor', 'lukas', 'zara', 'ivan', 'clara', 'samir', 'freya', 'pablo', 'amara', 'nils',
];

const LAST = [
  'okafor', 'lindqvist', 'moreau', 'tanaka', 'silva', 'novak', 'haddad', 'weber', 'rossi',
  'kowalski', 'nakamura', 'dubois', 'petrov', 'ahmed', 'mendes', 'bergman', 'costa',
  'fischer', 'iyer', 'laurent', 'vargas', 'sorensen', 'khoury', 'baptiste',
];

/**
 * Bios that say nothing useful. Roughly a third of real GitHub profiles look
 * like this, and a corpus without them is dishonestly easy to search: if every
 * developer announces their speciality in a tidy sentence, any ranker scores
 * near-perfectly and the evaluation cannot tell good retrieval from bad.
 */
const GENERIC_BIOS = [
  'Software engineer.',
  'Building things.',
  'Developer.',
  'I like computers.',
  'Engineer. Opinions my own.',
  'Open to interesting problems.',
  'she/her',
  'he/him',
  'they/them',
  'Currently learning.',
  'Ex-academia. Now shipping.',
  '',
];

const CITIES = [
  'Berlin, Germany', 'Lisbon, Portugal', 'Toronto, Canada', 'Austin, TX', 'Bengaluru, India',
  'London, UK', 'Amsterdam, Netherlands', 'Warsaw, Poland', 'Tokyo, Japan', 'Nairobi, Kenya',
  'Sao Paulo, Brazil', 'Seattle, WA', 'Stockholm, Sweden', 'Singapore', 'Barcelona, Spain',
  'Remote', 'Houston, TX', 'New York, NY', 'Dublin, Ireland', 'Melbourne, Australia',
];

const COMPANIES = [
  'Independent', 'Freelance', 'Northwind Labs', 'Helios Systems', 'Kestrel Data',
  'Open source', 'Meridian', 'Blackwood', 'Aperture Cloud', 'Studio Vantage', null, null,
];

export interface SyntheticDeveloper {
  user: GithubUser;
  repos: GithubRepo[];
  archetype: string;
}

const pick = <T>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)];

/**
 * Generates `count` developers spread evenly across archetypes.
 * @param seed Fixed by default so the corpus is reproducible.
 */
export function generateCorpus(count = 320, seed = 20260911): SyntheticDeveloper[] {
  const r = rng(seed);
  const out: SyntheticDeveloper[] = [];
  const usedLogins = new Set<string>();
  const now = Date.now();
  const DAY = 86_400_000;

  for (let i = 0; i < count; i++) {
    const archetype = ARCHETYPES[i % ARCHETYPES.length];

    /*
     * Realistic mess. An earlier version of this generator made every
     * developer a pure archetype with a tidy matching bio, and the retrieval
     * evaluation came back at 100% for every ranking mode - a saturated
     * benchmark that could not distinguish good ranking from bad. Real
     * profiles are noisier in three specific ways, all reproduced here:
     *
     *   blended    Many engineers work across two areas. A blended developer
     *              draws a minority of their repositories from a second
     *              archetype, so language and topic evidence is mixed.
     *   vague      A large share of GitHub bios say nothing ("Software
     *              engineer.") or are empty, removing the strongest semantic
     *              signal and forcing the ranker onto repository evidence.
     *   sparse     Plenty of real repositories have no description and no
     *              topics at all.
     *
     * The archetype recorded for labelling is always the PRIMARY one, so the
     * relevance judgements stay exact while the retrieval task gets hard.
     */
    const isBlended = r() < 0.35;
    const secondary = isBlended
      ? ARCHETYPES[(i + 1 + Math.floor(r() * (ARCHETYPES.length - 1))) % ARCHETYPES.length]
      : null;
    const bioStyle = r();

    const first = pick(r, FIRST);
    const last = pick(r, LAST);

    // The `demo-` prefix makes synthetic handles obvious at a glance and keeps
    // them from colliding with any real GitHub login.
    let login = `demo-${first}-${last.slice(0, 4)}`;
    let n = 2;
    while (usedLogins.has(login)) login = `demo-${first}-${last.slice(0, 4)}${n++}`;
    usedLogins.add(login);

    // A long tail: most people have modest numbers, a few are prominent. A
    // uniform distribution would make ranking look better than it is.
    const prominence = Math.pow(r(), 2.2);
    const followers = Math.round(3 + prominence * 4200);
    const repoCount = 4 + Math.floor(r() * 26);
    const tenureYears = 1 + r() * 12;

    const repos: GithubRepo[] = [];
    const repoNamesUsed = new Set<string>();
    for (let j = 0; j < repoCount; j++) {
      const isFork = r() < 0.22;

      // A blended developer spends about a third of their repositories in
      // their secondary area, which is what makes language and topic evidence
      // ambiguous the way it is on real profiles.
      const source = secondary && r() < 0.33 ? secondary : archetype;

      // Primary language dominates; the rest tail off.
      const langIdx = r() < 0.62 ? 0 : 1 + Math.floor(r() * (source.languages.length - 1));
      const language = source.languages[langIdx];

      // Names must be unique per developer - the corpus writer upserts on
      // (developer_id, name) and a duplicate inside one batch is an error.
      const base = pick(r, source.repoNames);
      let name = j === 0 && !repoNamesUsed.has(base) ? base : `${base}-${j}`;
      while (repoNamesUsed.has(name)) name = `${base}-${j}-${repoNamesUsed.size}`;
      repoNamesUsed.add(name);
      const stars = isFork
        ? Math.floor(r() * 3)
        : Math.round(Math.pow(r(), 3.4) * prominence * 3800);

      const daysOld = Math.floor(r() * tenureYears * 365);
      const daysSincePush = Math.floor(Math.pow(r(), 1.8) * Math.min(daysOld + 1, 900));

      repos.push({
        name,
        full_name: `${login}/${name}`,
        html_url: `https://github.com/${login}/${name}`,
        // Real repositories frequently carry no description and no topics.
        description: isFork || r() < 0.3 ? null : pick(r, source.repoBlurbs),
        language,
        stargazers_count: stars,
        forks_count: Math.floor(stars * (0.08 + r() * 0.22)),
        fork: isFork,
        archived: !isFork && r() < 0.08,
        pushed_at: new Date(now - daysSincePush * DAY).toISOString(),
        topics:
          isFork || r() < 0.4
            ? []
            : [...source.topics].sort(() => r() - 0.5).slice(0, 2 + Math.floor(r() * 3)),
      });
    }

    const user: GithubUser = {
      login,
      // Synthetic ids sit in a band no real GitHub account occupies.
      id: 900_000_000 + i,
      name: `${first[0].toUpperCase()}${first.slice(1)} ${last[0].toUpperCase()}${last.slice(1)}`,
      avatar_url: `https://api.dicebear.com/7.x/identicon/svg?seed=${login}`,
      html_url: `https://github.com/${login}`,
      // ~30% vague, ~12% empty, the rest a real description of their work.
      bio:
        bioStyle < 0.12
          ? null
          : bioStyle < 0.42
            ? pick(r, GENERIC_BIOS) || null
            : pick(r, archetype.bios),
      location: pick(r, CITIES),
      company: pick(r, COMPANIES),
      blog: r() < 0.35 ? `https://${first}${last}.dev` : null,
      email: null,
      hireable: r() < 0.3 ? true : r() < 0.6 ? false : null,
      followers,
      following: Math.floor(r() * 400),
      public_repos: repoCount,
      created_at: new Date(now - tenureYears * 365 * DAY).toISOString(),
    };

    out.push({ user, repos, archetype: archetype.key });
  }

  return out;
}

export const ARCHETYPE_KEYS = ARCHETYPES.map((a) => a.key);
