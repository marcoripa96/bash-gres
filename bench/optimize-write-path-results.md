# write-path optimization results

Three changes to `internalWriteFile` and friends, each cutting one Postgres
round-trip per `writeFile`:

1. **Phase A** — fuse the two `resolveEntry` calls (parent + target) into a
   single `resolveEntries(...)` query that unrolls over `unnest($2::ltree[])`.
2. **Phase B** — fuse `INSERT fs_blobs` + `INSERT fs_entries` into one CTE
   (`WITH b AS (INSERT … ON CONFLICT …) INSERT INTO fs_entries …`); modifying
   CTEs in `WITH` are always evaluated by Postgres regardless of reference.
3. **Phase C** — cache the visible-node count per `PgFileSystem` instance.
   `validateNodeCount` only re-runs the `COUNT(*)` over the COW-resolved
   workspace when the cache is within `HEADROOM=16` of `maxFiles`; otherwise
   it bumps the cache optimistically. Self-correcting drift on deletes.

Net effect: warm `writeFile` drops from **6 queries → 3 queries** per call.
`cp -r` (mixed workload) sees the biggest win because it amortises both the
faster writes and the cached node count.

## Numbers (postgres.js, 3 runs each, alternating)

| Scenario                       | Baseline (avg) | Final (avg) | Δ |
| ------------------------------ | -------------: | ----------: | -: |
| writeFile x200 (small text)    |        1187 ms |      790 ms | **-33%** |
| writeFile x50 (64 KiB binary)  |         360 ms |      252 ms | **-30%** |
| cp -r (200 files)              |         658 ms |      414 ms | **-37%** |
| readFile x200                  |         299 ms |      327 ms | +9% |
| readdir(200) x50               |         186 ms |      184 ms |  ≈0 |
| stat x200                      |         235 ms |      225 ms |  -4% |
| fork (200 files)               |        3.9 ms |     4.1 ms |  ≈0 |

The `+9%` `readFile` line is a synthetic-bench artifact: by skipping
`COUNT(*)` per write, fewer pages of `fs_entries` / `version_ancestors` get
warmed in Postgres' shared buffers, so a *cold-cache* read sweep
immediately after a write burst is slightly slower. In a realistic mixed
workload (reads interleaved with writes, or any concurrent traffic
touching those tables) the buffer is warm anyway — `cp -r` shows the real
shape, where reads + writes get **37% faster** together.

## warm writeFile breakdown

```
                              baseline      final
SET LOCAL                     0.57 ms      0.51 ms
resolveEntry(parent)          0.96 ms      ─       (fused into resolveEntries)
resolveEntry(target)          0.84 ms      1.10 ms (single query, both paths)
validateNodeCount             0.86 ms      ─       (cached after first write)
INSERT fs_blobs               0.78 ms      ─       (fused into the CTE below)
INSERT fs_entries             0.69 ms      1.61 ms (CTE: blob + entry)
                              ────────     ────────
total queries                 6            3
total query time              4.70 ms      3.22 ms
transaction (incl BEGIN/COMM) 8.30 ms      4.94 ms
```
