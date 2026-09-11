import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { baseLogger } from './logger.js';

/**
 * The narrow slice of Redis that DevScout actually uses, behind an interface
 * with two implementations:
 *
 *   - RedisStore  : real Redis (or Upstash/Elasticache over TLS).
 *   - MemoryStore : the same semantics inside one process.
 *
 * The memory store keeps local development and CI a zero-dependency `npm run
 * dev`, and it is genuinely correct for a single instance. It is NOT correct
 * across replicas - two instances would keep separate rate-limit windows and
 * separate queues - so production configures REDIS_URL and `/api/health/ready`
 * reports which backend is live.
 */
export interface Store {
  readonly kind: 'redis' | 'memory';
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  /** Sliding-window counter: records a hit and returns hits inside the window. */
  hitWindow(key: string, windowSeconds: number): Promise<number>;
  /** Queue: push onto the head of a list. */
  push(list: string, value: string): Promise<void>;
  /** Queue: atomically pop the tail. Returns null when empty. */
  pop(list: string): Promise<string | null>;
  len(list: string): Promise<number>;
  /** Delayed set, scored by the epoch-ms at which an item becomes due. */
  scheduleAt(zset: string, value: string, dueAtMs: number): Promise<void>;
  /** Moves every due item out of the delayed set and returns them. */
  takeDue(zset: string, nowMs: number, limit: number): Promise<string[]>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

class RedisStore implements Store {
  readonly kind = 'redis' as const;
  constructor(private r: Redis) {}

  get = (k: string) => this.r.get(k);
  async set(k: string, v: string, ttl?: number) {
    if (ttl) await this.r.set(k, v, 'EX', ttl);
    else await this.r.set(k, v);
  }
  async del(...keys: string[]) {
    if (keys.length) await this.r.del(...keys);
  }

  async hitWindow(key: string, windowSeconds: number) {
    const now = Date.now();
    const cutoff = now - windowSeconds * 1000;
    // One round trip: drop expired members, add this hit, count, re-arm the TTL.
    const res = await this.r
      .multi()
      .zremrangebyscore(key, 0, cutoff)
      .zadd(key, now, `${now}-${Math.random().toString(36).slice(2, 8)}`)
      .zcard(key)
      .expire(key, windowSeconds + 1)
      .exec();
    return Number(res?.[2]?.[1] ?? 0);
  }

  push = async (l: string, v: string) => void (await this.r.lpush(l, v));
  pop = (l: string) => this.r.rpop(l);
  len = (l: string) => this.r.llen(l);
  scheduleAt = async (z: string, v: string, due: number) => void (await this.r.zadd(z, due, v));

  async takeDue(z: string, now: number, limit: number) {
    const due = await this.r.zrangebyscore(z, 0, now, 'LIMIT', 0, limit);
    if (due.length) await this.r.zrem(z, ...due);
    return due;
  }

  async ping() {
    try {
      return (await this.r.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
  close = async () => void (await this.r.quit().catch(() => undefined));
}

class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private kv = new Map<string, { v: string; exp: number }>();
  private windows = new Map<string, number[]>();
  private lists = new Map<string, string[]>();
  private zsets = new Map<string, Array<{ v: string; score: number }>>();
  private sweeper: NodeJS.Timeout;

  constructor() {
    // Expiry is lazy on read; this sweep just stops abandoned keys from
    // growing the heap forever in a long-lived process.
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [k, e] of this.kv) if (e.exp && e.exp < now) this.kv.delete(k);
    }, 60_000);
    this.sweeper.unref?.();
  }

  async get(k: string) {
    const e = this.kv.get(k);
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) {
      this.kv.delete(k);
      return null;
    }
    return e.v;
  }
  async set(k: string, v: string, ttl?: number) {
    this.kv.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : 0 });
  }
  async del(...keys: string[]) {
    for (const k of keys) this.kv.delete(k);
  }

  async hitWindow(key: string, windowSeconds: number) {
    const now = Date.now();
    const cutoff = now - windowSeconds * 1000;
    const hits = (this.windows.get(key) ?? []).filter((t) => t > cutoff);
    hits.push(now);
    this.windows.set(key, hits);
    return hits.length;
  }

  async push(l: string, v: string) {
    const arr = this.lists.get(l) ?? [];
    arr.unshift(v);
    this.lists.set(l, arr);
  }
  async pop(l: string) {
    const arr = this.lists.get(l);
    return arr?.length ? (arr.pop() as string) : null;
  }
  async len(l: string) {
    return this.lists.get(l)?.length ?? 0;
  }
  async scheduleAt(z: string, v: string, due: number) {
    const arr = this.zsets.get(z) ?? [];
    arr.push({ v, score: due });
    this.zsets.set(z, arr);
  }
  async takeDue(z: string, now: number, limit: number) {
    const arr = this.zsets.get(z) ?? [];
    const due = arr.filter((e) => e.score <= now).slice(0, limit);
    this.zsets.set(
      z,
      arr.filter((e) => !due.includes(e)),
    );
    return due.map((e) => e.v);
  }
  async ping() {
    return true;
  }
  async close() {
    clearInterval(this.sweeper);
  }
}

function build(): Store {
  if (!env.REDIS_URL) {
    baseLogger.warn(
      { backend: 'memory' },
      'REDIS_URL not set - cache, rate limiter and queue are in-process. Single instance only.',
    );
    return new MemoryStore();
  }
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    lazyConnect: false,
    // Serverless platforms recycle sockets aggressively; keep reconnects cheap.
    retryStrategy: (times) => Math.min(times * 200, 2000),
    ...(env.REDIS_URL.startsWith('rediss://') ? { tls: {} } : {}),
  });
  client.on('error', (e) => baseLogger.error({ err: e.message }, 'redis error'));
  client.on('connect', () => baseLogger.info({ backend: 'redis' }, 'redis connected'));
  return new RedisStore(client);
}

export const store: Store = build();
