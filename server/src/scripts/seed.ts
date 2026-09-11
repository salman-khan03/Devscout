import { pool, query, asTenant, transaction } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../lib/auth.js';
import { baseLogger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { generateCorpus } from './synthetic.js';
import { upsertDeveloper } from '../services/corpus.js';
import { githubConfigured, getUser, getRepos } from '../services/github.js';

/**
 * Seeds a working demo: a corpus to search, two organisations to prove tenant
 * isolation, and users at every role so the RBAC ladder is visible.
 *
 * Idempotent - safe to re-run. Developers upsert on login, orgs and users are
 * skipped when they already exist.
 */

const DEMO_PASSWORD = 'devscout-demo';

/**
 * Real handles used when a GITHUB_TOKEN is available. These are well-known
 * maintainers of the projects named; DevScout reads only their public profile
 * and repository metadata, exactly as an unauthenticated visitor would.
 */
const REAL_HANDLES = [
  'sindresorhus', 'tj', 'kentcdodds', 'gaearon', 'yyx990803', 'mitsuhiko',
  'jashkenas', 'addyosmani', 'bradfitz', 'peterbourgon', 'burntsushi',
  'dtolnay', 'rauchg', 'leerob', 'shadcn', 'antfu', 'wesbos', 'simonw',
  'tiangolo', 'charliermarsh', 'jakevdp', 'ageron', 'karpathy', 'soumith',
];

async function seedCorpus(): Promise<number> {
  if (githubConfigured()) {
    baseLogger.info({ handles: REAL_HANDLES.length }, 'GITHUB_TOKEN found - ingesting real profiles');
    let ok = 0;
    for (const login of REAL_HANDLES) {
      try {
        const [user, repos] = await Promise.all([getUser(login), getRepos(login)]);
        await upsertDeveloper(user, repos, { synthetic: false });
        ok++;
        baseLogger.info({ login, progress: `${ok}/${REAL_HANDLES.length}` }, 'ingested');
      } catch (e) {
        baseLogger.warn({ login, err: (e as Error).message }, 'skipped');
      }
    }
    return ok;
  }

  baseLogger.info('No GITHUB_TOKEN - generating the synthetic demo corpus');
  const corpus = generateCorpus();
  let done = 0;

  for (const { user, repos } of corpus) {
    await upsertDeveloper(user, repos, { synthetic: true });
    if (++done % 50 === 0) {
      baseLogger.info({ progress: `${done}/${corpus.length}` }, 'corpus written');
    }
  }
  return done;
}

interface SeedUser {
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'recruiter' | 'viewer';
}

async function seedOrg(
  slug: string,
  name: string,
  plan: string,
  status: string,
  users: SeedUser[],
): Promise<string | null> {
  const existing = await query(`SELECT id FROM orgs WHERE slug = $1`, [slug]);
  if (existing.rowCount) {
    baseLogger.info({ slug }, 'org already seeded, skipping');
    return existing.rows[0].id;
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const orgId = await transaction(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO orgs (name, slug, plan, subscription_status, seats, current_period_end)
       VALUES ($1, $2, $3, $4, $5, now() + interval '30 days')
       RETURNING id`,
      [name, slug, plan, status, users.length],
    );
    const id = rows[0].id as string;

    for (const u of users) {
      const { rows: ur } = await db.query(
        `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [u.email, passwordHash, u.name],
      );
      await db.query(
        `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [id, ur[0].id, u.role],
      );
    }
    return id;
  });

  baseLogger.info({ slug, users: users.length }, 'org seeded');
  return orgId;
}

/** Populates one org with pipelines, saved searches and analytics history. */
async function seedWorkspace(orgId: string): Promise<void> {
  const { rows: members } = await query(
    `SELECT user_id, role FROM memberships WHERE org_id = $1 ORDER BY role`,
    [orgId],
  );
  const actor = members[0]?.user_id ?? null;

  // A spread of archetypes so every pipeline stage has someone in it.
  const { rows: devs } = await query(
    `SELECT id FROM developers ORDER BY activity_score DESC, total_stars DESC LIMIT 24`,
  );
  if (!devs.length) return;

  await asTenant(orgId, async (db) => {
    await db.query(
      `INSERT INTO lists (org_id, name, description, color, is_default, created_by)
       VALUES ($1, 'Backend Platform Q1', 'Senior backend and distributed systems.', 'indigo', true, $2),
              ($1, 'Frontend Design Engineers', 'React, design systems, accessibility.', 'amber', false, $2)
       ON CONFLICT (org_id, name) DO NOTHING`,
      [orgId, actor],
    );

    // RETURNING on an upsert yields nothing for rows that already existed, so
    // reading the ids back is what keeps a re-run idempotent rather than a
    // silent no-op. Re-seeding after a corpus truncate has to refill these.
    const { rows: listRows } = await db.query(
      `SELECT id FROM lists WHERE org_id = $1 ORDER BY is_default DESC, created_at LIMIT 2`,
      [orgId],
    );
    if (!listRows.length) return;

    const stages = ['sourced', 'sourced', 'contacted', 'contacted', 'screening', 'interview', 'offer'];
    let i = 0;
    for (const list of listRows) {
      for (const dev of devs.slice(i * 10, i * 10 + 10)) {
        await db.query(
          `INSERT INTO list_members (org_id, list_id, developer_id, stage, position, added_by, source_query, rating)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (list_id, developer_id) DO NOTHING`,
          [
            orgId,
            list.id,
            dev.id,
            stages[Math.floor(Math.random() * stages.length)],
            i,
            actor,
            i === 0 ? 'distributed systems go' : 'react design systems accessibility',
            Math.random() < 0.5 ? 3 + Math.floor(Math.random() * 3) : null,
          ],
        );
        // Analytics history so the dashboard is not empty on first open.
        await db.query(
          `INSERT INTO activity_events (org_id, user_id, developer_id, action, created_at)
           VALUES ($1,$2,$3,'viewed', now() - (random() * interval '20 days')),
                  ($1,$2,$3,'shortlisted', now() - (random() * interval '18 days'))`,
          [orgId, actor, dev.id],
        );
      }
      i++;
    }

    await db.query(
      `INSERT INTO saved_searches (org_id, name, query, filters, created_by, run_count, last_run_at)
       VALUES
         ($1, 'Rust systems, actively shipping', 'rust systems programming async',
          '{"languages":["Rust"],"activeWithinDays":90,"minStars":50}'::jsonb, $2, 12, now() - interval '2 days'),
         ($1, 'Senior Go + Kubernetes', 'go kubernetes distributed systems',
          '{"languages":["Go"],"seniority":["Senior","Staff+"]}'::jsonb, $2, 8, now() - interval '5 days'),
         ($1, 'Accessibility-minded React', 'react accessibility design systems',
          '{"languages":["TypeScript"],"topics":["accessibility"]}'::jsonb, $2, 5, now() - interval '1 day')
       ON CONFLICT (org_id, name) DO NOTHING`,
      [orgId, actor],
    );

    // Search history spread over three weeks for the analytics charts.
    const queries = [
      'rust systems programming', 'go kubernetes', 'react accessibility',
      'machine learning pytorch', 'terraform aws sre', 'swift ios offline',
      'kafka streaming data', 'security fuzzing',
    ];
    for (const q of queries) {
      await db.query(
        `INSERT INTO search_events (org_id, user_id, query, mode, result_count, took_ms, created_at)
         SELECT $1, $2, $3, 'hybrid',
                (10 + random() * 80)::int,
                (18 + random() * 120)::int,
                now() - (random() * interval '21 days')
           FROM generate_series(1, (2 + random() * 6)::int)`,
        [orgId, actor, q],
      );
    }
  });

  baseLogger.info({ orgId }, 'workspace seeded');
}

async function main(): Promise<void> {
  const { applied } = await migrate();
  if (applied.length) baseLogger.info({ applied: applied.length }, 'migrations applied');

  const developers = await seedCorpus();

  const primary = await seedOrg('northwind-talent', 'Northwind Talent', 'team', 'active', [
    { email: 'demo@devscout.dev', name: 'Demo Owner', role: 'owner' },
    { email: 'admin@devscout.dev', name: 'Avery Admin', role: 'admin' },
    { email: 'recruiter@devscout.dev', name: 'Robin Recruiter', role: 'recruiter' },
    { email: 'viewer@devscout.dev', name: 'Val Viewer', role: 'viewer' },
  ]);

  // A second tenant with its own data. The isolation test in test/ asserts
  // that neither org can see the other's lists, and this is what it runs on.
  const secondary = await seedOrg('globex-recruiting', 'Globex Recruiting', 'free', 'inactive', [
    { email: 'other@devscout.dev', name: 'Other Org Owner', role: 'owner' },
  ]);

  if (primary) await seedWorkspace(primary);
  if (secondary) await seedWorkspace(secondary);

  const { rows: counts } = await query(`
    SELECT (SELECT count(*) FROM developers) AS developers,
           (SELECT count(*) FROM developers WHERE embedding IS NOT NULL) AS embedded,
           (SELECT count(*) FROM orgs) AS orgs,
           (SELECT count(*) FROM users) AS users,
           (SELECT count(*) FROM list_members) AS saved
  `);

  baseLogger.info({ developers, ...counts[0] }, 'seed complete');

  /* eslint-disable no-console */
  console.log(`
  DevScout is seeded.

    Developers   ${counts[0].developers}  (${counts[0].embedded} embedded${
      githubConfigured() ? '' : ', synthetic demo corpus'
    })
    Workspaces   ${counts[0].orgs}
    Sign in      demo@devscout.dev / ${DEMO_PASSWORD}        (owner, Team plan)
                 recruiter@devscout.dev / ${DEMO_PASSWORD}   (recruiter)
                 viewer@devscout.dev / ${DEMO_PASSWORD}      (read-only)
                 other@devscout.dev / ${DEMO_PASSWORD}       (separate tenant)

    Next: npm run dev    then open ${env.WEB_ORIGIN}
  `);
  /* eslint-enable no-console */
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((e) => {
    baseLogger.error({ err: e.message, stack: e.stack }, 'seed failed');
    process.exit(1);
  });
