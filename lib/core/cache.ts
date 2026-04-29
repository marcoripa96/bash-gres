/**
 * Adapter interface for caching `PgFileSystem` read results.
 *
 * Adapters are intentionally tiny: byte-oriented `get`/`set`, batch `delete`,
 * and prefix `clear`. Encoding and key composition live in the wrapper, not
 * here, so a Redis adapter and an in-memory `Map` can share the same shape.
 *
 * Keys are composed by the wrapper as
 * `${workspaceId}:${versionLabel}:${op}:${path}` (and similar). Adapters MUST
 * NOT inspect or rewrite keys; they are opaque strings.
 */
export interface FsCache {
  /** Return the value previously stored under `key`, or `null` if absent or expired. */
  get(key: string): Promise<Uint8Array | null>;

  /**
   * Store `value` under `key`. If `ttlMs` is provided, the entry expires after
   * that many milliseconds; otherwise it lives until evicted by the adapter's
   * own policy (e.g. LRU) or removed by `delete`/`clear`.
   */
  set(key: string, value: Uint8Array, ttlMs?: number): Promise<void>;

  /** Remove every supplied key. Missing keys are silently ignored. */
  delete(keys: string[]): Promise<void>;

  /** Remove every entry whose key starts with `prefix`. Used for workspace/version invalidation. */
  clear(prefix: string): Promise<void>;
}
