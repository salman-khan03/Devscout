import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from '../db/pool.js';
import { store } from '../lib/redis.js';
import { search, type RankMode } from '../services/ranking.js';
import { generateCorpus } from '../scripts/synthetic.js';
import { activeModel } from '../services/embeddings.js';

/**
 * Retrieval evaluation.
 *
 * The claim "hybrid ranking beats lexical or vector alone" is easy to write in
 * a README and worthless unless it is measured. This scores all four ranking
 * modes over a labelled query set and prints the comparison.
 *
 * WHAT THE NUMBERS MEAN, AND DO NOT MEAN. On the synthetic corpus, relevance
 * is derived from the archetype each developer was generated from, so the
 * labels are exact. That makes the comparison between modes fair - every mode
 * is scored against identical judgements - but it does not make the absolute
 * numbers a claim about real-world recruiting relevance. A synthetic corpus is
 * cleaner than reality: real profiles are noisier, and absolute precision
 * would be lower. The honest reading is the ordering and the size of the gaps,
 * not the headline percentage.
 *
 * Run with a real corpus and your own labels to measure something stronger.
 *
 *   npm run eval              all modes, summary table
 *   npm run eval -- --verbose per-query breakdown
 */

interface GoldenQuery {
  id: string;
  query: string;
  relevantArchetypes: string[];
  kind: 'explicit' | 'descriptive';
}

interface Metrics {
  precisionAt10: number;
  recallAt50: number;
  mrr: number;
  ndcgAt10: number;
  meanLatencyMs: number;
  zeroResultQueries: number;
}

const MODES: RankMode[] = ['lexical', 'vector', 'signal', 'hybrid'];

function precisionAtK(ranked: string[], relevant: Set<string>, k: number): number {
  const top = ranked.slice(0, k);
  if (!top.length) return 0;
  return top.filter((id) => relevant.has(id)).length / Math.min(k, top.length);
}

function recallAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (!relevant.size) return 0;
  return ranked.slice(0, k).filter((id) => relevant.has(id)).length / relevant.size;
}

function reciprocalRank(ranked: string[], relevant: Set<string>): number {
  const idx = ranked.findIndex((id) => relevant.has(id));
  return idx === -1 ? 0 : 1 / (idx + 1);
}

/**
 * Binary-gain nDCG. The discount rewards putting relevant people high, not
 * merely somewhere in the page - which is the whole point of a top-10 list a
 * recruiter will actually read.
 */
function ndcgAtK(ranked: string[], relevant: Set<string>, k: number): number {
  let dcg = 0;
  ranked.slice(0, k).forEach((id, i) => {
    if (relevant.has(id)) dcg += 1 / Math.log2(i + 2);
  });
  let idcg = 0;
  for (let i = 0; i < Math.min(k, relevant.size); i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const verbose = process.argv.includes('--verbose');
  const here = dirname(fileURLToPath(import.meta.url));
  const golden = JSON.parse(readFileSync(join(here, 'golden.json'), 'utf8')) as {
    queries: GoldenQuery[];
  };

  // Corpus sanity: the labels below only describe the synthetic corpus.
  const { rows: stat } = await query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE is_synthetic)::int AS synthetic,
           count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded
      FROM developers`);
  const corpus = stat[0];

  if (!corpus.total) {
    console.error('The corpus is empty. Run `npm run seed` first.');
    process.exit(1);
  }
  if (corpus.synthetic !== corpus.total) {
    console.error(
      `\nThis harness labels relevance by synthetic archetype, but ${
        corpus.total - corpus.synthetic
      } of ${corpus.total} developers are real profiles.\n` +
        'Those rows have no archetype label, so the scores below would be meaningless.\n' +
        'Re-seed without GITHUB_TOKEN, or supply your own judgements in golden.json.\n',
    );
    process.exit(1);
  }

  // Rebuild the login -> archetype map. Same seed, same corpus, so this is the
  // exact assignment the seeder used.
  const loginToArchetype = new Map<string, string>();
  for (const d of generateCorpus()) loginToArchetype.set(d.user.login, d.archetype);

  const { rows: devs } = await query(`SELECT id, login FROM developers`);
  const idToArchetype = new Map<string, string>();
  for (const d of devs) {
    const a = loginToArchetype.get(d.login);
    if (a) idToArchetype.set(d.id, a);
  }

  console.log(`
DevScout retrieval evaluation
  corpus     ${corpus.total} developers (${corpus.embedded} embedded)
  embeddings ${activeModel()}
  queries    ${golden.queries.length} labelled (${
    golden.queries.filter((q) => q.kind === 'explicit').length
  } naming a stack, ${
    golden.queries.filter((q) => q.kind === 'descriptive').length
  } describing the work)
`);

  const results = new Map<RankMode, Metrics>();
  const perQuery = new Map<RankMode, Array<{ q: GoldenQuery; p10: number }>>();

  for (const mode of MODES) {
    let p10 = 0;
    let r50 = 0;
    let mrr = 0;
    let ndcg = 0;
    let latency = 0;
    let zero = 0;
    const rows: Array<{ q: GoldenQuery; p10: number }> = [];

    for (const gq of golden.queries) {
      const relevant = new Set(
        [...idToArchetype.entries()]
          .filter(([, a]) => gq.relevantArchetypes.includes(a))
          .map(([id]) => id),
      );

      const res = await search({ q: gq.query, mode, limit: 50 }, null);
      const ranked = res.results.map((r) => r.id);
      if (!ranked.length) zero++;

      const queryP10 = precisionAtK(ranked, relevant, 10);
      p10 += queryP10;
      r50 += recallAtK(ranked, relevant, 50);
      mrr += reciprocalRank(ranked, relevant);
      ndcg += ndcgAtK(ranked, relevant, 10);
      latency += res.tookMs;
      rows.push({ q: gq, p10: queryP10 });
    }

    const n = golden.queries.length;
    results.set(mode, {
      precisionAt10: p10 / n,
      recallAt50: r50 / n,
      mrr: mrr / n,
      ndcgAt10: ndcg / n,
      meanLatencyMs: latency / n,
      zeroResultQueries: zero,
    });
    perQuery.set(mode, rows);
  }

  // ---- summary table ------------------------------------------------------
  const head = ['mode', 'P@10', 'R@50', 'MRR', 'nDCG@10', 'latency', 'zero'];
  const widths = [10, 8, 8, 8, 9, 9, 6];
  console.log(head.map((h, i) => h.padEnd(widths[i])).join(''));
  console.log(widths.map((w) => '-'.repeat(w - 1)).join(' '));

  for (const mode of MODES) {
    const m = results.get(mode)!;
    console.log(
      [
        mode,
        pct(m.precisionAt10),
        pct(m.recallAt50),
        m.mrr.toFixed(3),
        m.ndcgAt10.toFixed(3),
        `${m.meanLatencyMs.toFixed(0)}ms`,
        String(m.zeroResultQueries),
      ]
        .map((c, i) => c.padEnd(widths[i]))
        .join(''),
    );
  }

  // ---- the comparison the design rests on ---------------------------------
  const hybrid = results.get('hybrid')!;
  const best = MODES.filter((m) => m !== 'hybrid')
    .map((m) => ({ mode: m, ...results.get(m)! }))
    .sort((a, b) => b.ndcgAt10 - a.ndcgAt10)[0];

  const lift = best.ndcgAt10 > 0 ? (hybrid.ndcgAt10 - best.ndcgAt10) / best.ndcgAt10 : 0;
  console.log(
    `\nHybrid vs best single ranker (${best.mode}): ` +
      `nDCG@10 ${best.ndcgAt10.toFixed(3)} -> ${hybrid.ndcgAt10.toFixed(3)} (${
        lift >= 0 ? '+' : ''
      }${(lift * 100).toFixed(1)}%)`,
  );

  // Split by query kind - this is where the two rankers earn their keep.
  for (const kind of ['explicit', 'descriptive'] as const) {
    const line = MODES.map((mode) => {
      const rows = perQuery.get(mode)!.filter((r) => r.q.kind === kind);
      const avg = rows.reduce((s, r) => s + r.p10, 0) / (rows.length || 1);
      return `${mode} ${pct(avg)}`;
    }).join('   ');
    console.log(`  P@10 on ${kind.padEnd(11)} queries:  ${line}`);
  }

  if (verbose) {
    console.log('\nPer-query P@10:\n');
    for (const gq of golden.queries) {
      const cells = MODES.map((m) => {
        const row = perQuery.get(m)!.find((r) => r.q.id === gq.id)!;
        return `${m.slice(0, 3)} ${pct(row.p10).padStart(6)}`;
      }).join('  ');
      console.log(`  ${gq.id.padEnd(4)} ${cells}   ${gq.query}`);
    }
  }

  console.log(
    '\nRelevance is labelled by synthetic archetype, so these numbers compare' +
      '\nranking modes fairly but are not a claim about real-world precision.\n',
  );
}

main()
  .then(async () => {
    await pool.end();
    await store.close();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error('eval failed:', e);
    await pool.end().catch(() => undefined);
    await store.close().catch(() => undefined);
    process.exit(1);
  });
