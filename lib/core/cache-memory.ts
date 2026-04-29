import type { FsCache } from "./cache.js";

interface Entry {
  value: Uint8Array;
  expiresAt: number | null;
}

export interface InMemoryFsCacheOptions {
  /** Maximum total payload size in bytes. Older entries are evicted in LRU order when exceeded. Default: 64 MiB. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * In-process LRU cache with a byte budget. Insertion order in the underlying
 * `Map` is the LRU ordering: a successful `get` re-inserts the entry to mark
 * it as most-recently-used. Eviction walks the iterator from the front (the
 * least-recently-used end) until the byte budget is satisfied.
 *
 * Single-process only. Sharing one instance across `PgFileSystem` instances
 * for the same workspace is safe; sharing across processes is not — use a
 * Redis adapter for that.
 */
export class InMemoryFsCache implements FsCache {
  private readonly store = new Map<string, Entry>();
  private readonly maxBytes: number;
  private currentBytes = 0;

  constructor(options: InMemoryFsCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.currentBytes -= entry.value.byteLength;
      return null;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  async set(key: string, value: Uint8Array, ttlMs?: number): Promise<void> {
    const previous = this.store.get(key);
    if (previous) {
      this.currentBytes -= previous.value.byteLength;
      this.store.delete(key);
    }
    if (value.byteLength > this.maxBytes) return;
    const expiresAt =
      ttlMs !== undefined && ttlMs > 0 ? Date.now() + ttlMs : null;
    this.store.set(key, { value, expiresAt });
    this.currentBytes += value.byteLength;
    while (this.currentBytes > this.maxBytes) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      const oldestKey = oldest.value;
      const oldestEntry = this.store.get(oldestKey)!;
      this.store.delete(oldestKey);
      this.currentBytes -= oldestEntry.value.byteLength;
    }
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) {
      const entry = this.store.get(key);
      if (entry) {
        this.currentBytes -= entry.value.byteLength;
        this.store.delete(key);
      }
    }
  }

  async clear(prefix: string): Promise<void> {
    if (prefix.length === 0) {
      this.store.clear();
      this.currentBytes = 0;
      return;
    }
    for (const [key, entry] of this.store) {
      if (key.startsWith(prefix)) {
        this.currentBytes -= entry.value.byteLength;
        this.store.delete(key);
      }
    }
  }

  /** Total bytes currently stored. Exposed for diagnostics and tests. */
  get sizeBytes(): number {
    return this.currentBytes;
  }

  /** Number of entries currently stored. Exposed for diagnostics and tests. */
  get size(): number {
    return this.store.size;
  }
}
