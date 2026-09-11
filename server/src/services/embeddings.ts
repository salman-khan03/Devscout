import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { embeddingCalls } from '../lib/metrics.js';
import { log } from '../lib/logger.js';
import { Cache } from '../lib/cache.js';

/**
 * Text -> 256-dimensional unit vector, from one of two providers.
 *
 *   openai : text-embedding-3-small, asked for 256 dimensions explicitly.
 *   local  : the hashed-feature embedder below. No network, no key, no cost,
 *            and deterministic - the same text always yields the same vector.
 *
 * The local embedder is what makes `git clone && npm run setup` produce a
 * working semantic search. It is genuinely weaker than a trained model at
 * matching paraphrases ("distributed systems" vs "scalability"), and the
 * evaluation harness in src/eval quantifies exactly how much weaker on a
 * labelled query set rather than leaving it as a claim.
 *
 * Vectors from the two providers live in different spaces and must never be
 * compared. Every row records `embedding_model`, and searches filter on the
 * currently active one.
 */
export const DIMENSIONS = 256;

export const activeModel = (): string =>
  env.EMBEDDING_PROVIDER === 'openai' ? 'openai:text-embedding-3-small:256' : 'local:hashed-v1:256';

const cache = new Cache<number[]>('embed', 24 * 60 * 60);

export async function embed(text: string): Promise<number[]> {
  const normalized = text.trim().replace(/\s+/g, ' ').slice(0, 8000);
  if (!normalized) return new Array(DIMENSIONS).fill(0);

  const key = createHash('sha256').update(`${activeModel()}:${normalized}`).digest('hex').slice(0, 32);

  return cache.wrap(key, async () => {
    if (env.EMBEDDING_PROVIDER === 'openai') {
      try {
        const v = await openaiEmbed(normalized);
        embeddingCalls.inc({ provider: 'openai', outcome: 'ok' });
        return v;
      } catch (e) {
        embeddingCalls.inc({ provider: 'openai', outcome: 'error' });
        // Falling back would mix embedding spaces and silently corrupt the
        // index, so this fails loudly instead.
        log().error({ err: (e as Error).message }, 'OpenAI embedding failed');
        throw e;
      }
    }
    embeddingCalls.inc({ provider: 'local', outcome: 'ok' });
    return localEmbed(normalized);
  });
}

/** Batch helper - one request per chunk rather than one per document. */
export async function embedMany(texts: string[]): Promise<number[][]> {
  if (env.EMBEDDING_PROVIDER !== 'openai') return texts.map((t) => localEmbed(t));
  const out: number[][] = [];
  const CHUNK = 64;
  for (let i = 0; i < texts.length; i += CHUNK) {
    const chunk = texts.slice(i, i + CHUNK);
    out.push(...(await openaiEmbedMany(chunk)));
  }
  return out;
}

async function openaiEmbed(text: string): Promise<number[]> {
  const [v] = await openaiEmbedMany([text]);
  return v;
}

async function openaiEmbedMany(input: string[]): Promise<number[][]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      dimensions: DIMENSIONS,
      input,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`OpenAI embeddings returned ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
  return body.data.sort((a, b) => a.index - b.index).map((d) => normalize(d.embedding));
}

// ---------------------------------------------------------------------------
// Local hashed-feature embedder
// ---------------------------------------------------------------------------

/**
 * A deterministic bag-of-features embedding, in the spirit of the hashing
 * trick. Each token is hashed into several dimensions with a signed weight, so
 * distinct tokens rarely collide destructively, and character trigrams are
 * included so near-misses ("postgres" / "postgresql") still land close
 * together. Sublinear term weighting stops a repeated word from dominating.
 */
export function localEmbed(text: string): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  const tokens = tokenize(text);
  if (!tokens.length) return v;

  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);

  for (const [token, count] of counts) {
    // 1 + log(tf): the fifth mention of "rust" should not outweigh everything.
    const weight = 1 + Math.log(count);
    addFeature(v, token, weight);
    // Trigrams give partial credit for morphological variants.
    for (const gram of trigrams(token)) addFeature(v, `#${gram}`, weight * 0.25);
  }

  return normalize(v);
}

/** Spreads one feature over 3 dimensions with deterministic signs. */
function addFeature(v: number[], feature: string, weight: number): void {
  const h = createHash('md5').update(feature).digest();
  for (let i = 0; i < 3; i++) {
    const idx = ((h[i * 2] << 8) | h[i * 2 + 1]) % DIMENSIONS;
    const sign = h[i * 2 + 6] % 2 === 0 ? 1 : -1;
    v[idx] += sign * weight;
  }
}

function trigrams(token: string): string[] {
  if (token.length < 4) return [];
  const out: string[] = [];
  for (let i = 0; i <= token.length - 3; i++) out.push(token.slice(i, i + 3));
  return out.slice(0, 12);
}

/** Words that carry no signal in a corpus that is entirely about software. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'at', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its',
  'this', 'that', 'as', 'i', 'my', 'me', 'we', 'you', 'your', 'who', 'which',
  'developer', 'engineer', 'software', 'code', 'coding', 'programmer', 'github',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // Keep +, # and . so c++, c#, node.js and .net survive tokenisation.
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .split(/[\s\-_/]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length > 1 && t.length < 32 && !STOP.has(t));
}

function normalize(v: number[]): number[] {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  // A unit vector makes cosine distance a pure dot product, which is what
  // pgvector's <=> operator is fastest at.
  return mag === 0 ? v : v.map((x) => x / mag);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
  return dot;
}
