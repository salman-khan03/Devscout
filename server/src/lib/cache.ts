import { store } from './redis.js';
import { cacheEvents } from './metrics.js';
import { log } from './logger.js';

/**
 * Namespaced JSON cache over the Store. Two properties worth calling out:
 *
 *  - Single-flight: concurrent callers for the same key share one in-flight
 *    promise, so a cold cache under load makes one upstream call, not N. This
 *    is what keeps a burst of recruiters opening the same profile from
 *    spending N of a 5000/hr GitHub budget.
 *  - Fail-open: if the cache backend is down, `wrap` still computes and
 *    returns the value. A cache outage must not become an app outage.
 */
export class Cache<V> {
  private inflight = new Map<string, Promise<V>>();

  constructor(
    private namespace: string,
    private ttlSeconds: number,
  ) {}

  private k = (key: string) => `cache:${this.namespace}:${key}`;

  async get(key: string): Promise<V | undefined> {
    try {
      const raw = await store.get(this.k(key));
      if (raw === null) {
        cacheEvents.inc({ namespace: this.namespace, result: 'miss' });
        return undefined;
      }
      cacheEvents.inc({ namespace: this.namespace, result: 'hit' });
      return JSON.parse(raw) as V;
    } catch (e) {
      log().warn({ err: (e as Error).message, namespace: this.namespace }, 'cache read failed');
      return undefined;
    }
  }

  async set(key: string, value: V, ttlSeconds = this.ttlSeconds): Promise<void> {
    try {
      await store.set(this.k(key), JSON.stringify(value), ttlSeconds);
    } catch (e) {
      log().warn({ err: (e as Error).message, namespace: this.namespace }, 'cache write failed');
    }
  }

  async invalidate(key: string): Promise<void> {
    await store.del(this.k(key)).catch(() => undefined);
  }

  async wrap(key: string, produce: () => Promise<V>, ttlSeconds = this.ttlSeconds): Promise<V> {
    const hit = await this.get(key);
    if (hit !== undefined) return hit;

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const p = produce()
      .then(async (value) => {
        await this.set(key, value, ttlSeconds);
        return value;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }
}
