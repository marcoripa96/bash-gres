interface Waiter<V> {
  resolve: (value: V | null) => void;
  reject: (error: unknown) => void;
}

export interface CoalescerLoaders<V> {
  /** Loads one key on its own: lone calls, and each key of a failed batch. */
  one: (key: string) => Promise<V | null>;
  /** Loads several keys in one round-trip; keys absent from the map are null. */
  many: (keys: string[]) => Promise<Map<string, V>>;
  /** Most keys one `many()` statement carries; bigger bursts split. */
  maxBatch: number;
  /** When true, `load()` runs `one()` right away (e.g. inside a transaction). */
  unbatched: () => boolean;
}

/**
 * Answers every `load()` issued in the same synchronous run with one `many()`
 * call at the next microtask. That is how just-bash fans out
 * (`Promise.all(names.map((n) => fs.stat(n)))`), so a burst costs one
 * round-trip instead of a pool's worth of waves. Callers must reach `load()`
 * before their first `await`; duplicate keys share one slot.
 *
 * Batching never changes what a caller gets. A lone key runs `one()`, and if
 * a `many()` statement fails (a path that can't be encoded, a statement
 * timeout, anything), each of its keys is retried through `one()`, so every
 * caller settles exactly as it would have without batching. `maxBatch` keeps
 * one statement from carrying a whole tree's worth of content under a single
 * statement timeout.
 */
export class Coalescer<V> {
  private pending: Map<string, Waiter<V>[]> | null = null;

  constructor(private readonly loaders: CoalescerLoaders<V>) {}

  load(key: string): Promise<V | null> {
    if (this.loaders.unbatched()) return this.loaders.one(key);
    let batch = this.pending;
    if (!batch) {
      const fresh = new Map<string, Waiter<V>[]>();
      this.pending = batch = fresh;
      queueMicrotask(() => this.flush(fresh));
    }
    const waiters = batch.get(key) ?? [];
    batch.set(key, waiters);
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  }

  private flush(batch: Map<string, Waiter<V>[]>): void {
    this.pending = null;
    const keys = [...batch.keys()];
    const { maxBatch } = this.loaders;
    for (let start = 0; start < keys.length; start += maxBatch) {
      const chunk = keys.slice(start, start + maxBatch);
      if (chunk.length === 1) {
        this.settleOne(chunk[0]!, batch);
      } else {
        void this.settleMany(chunk, batch);
      }
    }
  }

  private async settleMany(
    keys: string[],
    batch: Map<string, Waiter<V>[]>,
  ): Promise<void> {
    let values: Map<string, V>;
    try {
      values = await this.loaders.many(keys);
    } catch {
      for (const key of keys) this.settleOne(key, batch);
      return;
    }
    for (const key of keys) {
      const value = values.get(key) ?? null;
      for (const w of batch.get(key)!) w.resolve(value);
    }
  }

  private settleOne(key: string, batch: Map<string, Waiter<V>[]>): void {
    const waiters = batch.get(key)!;
    this.loaders.one(key).then(
      (value) => {
        for (const w of waiters) w.resolve(value);
      },
      (error: unknown) => {
        for (const w of waiters) w.reject(error);
      },
    );
  }
}
