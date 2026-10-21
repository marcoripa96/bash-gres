interface Waiter<V> {
  resolve: (value: V) => void;
  reject: (error: unknown) => void;
}

/**
 * Answers every `load()` issued in the same synchronous run with one
 * `loadMany()` call at the next microtask. That is how just-bash fans out
 * (`Promise.all(names.map((n) => fs.stat(n)))`), so a burst costs one
 * round-trip instead of a pool's worth of waves. Callers must reach `load()`
 * before their first `await`. Duplicate keys share one slot; keys missing
 * from the result get `missing`; a failed `loadMany()` rejects every caller
 * in the batch.
 */
export class Coalescer<V> {
  private pending: Map<string, Waiter<V>[]> | null = null;

  constructor(
    private readonly loadMany: (keys: string[]) => Promise<Map<string, V>>,
    private readonly missing: V,
  ) {}

  load(key: string): Promise<V> {
    let batch = this.pending;
    if (!batch) {
      const fresh = new Map<string, Waiter<V>[]>();
      this.pending = batch = fresh;
      queueMicrotask(() => void this.flush(fresh));
    }
    const waiters = batch.get(key) ?? [];
    batch.set(key, waiters);
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  }

  private async flush(batch: Map<string, Waiter<V>[]>): Promise<void> {
    this.pending = null;
    try {
      const values = await this.loadMany([...batch.keys()]);
      for (const [key, waiters] of batch) {
        const value = values.has(key) ? values.get(key)! : this.missing;
        for (const w of waiters) w.resolve(value);
      }
    } catch (error) {
      for (const waiters of batch.values()) {
        for (const w of waiters) w.reject(error);
      }
    }
  }
}
