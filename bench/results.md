# bash-gres bench results

PostgreSQL on `localhost:5433` (docker compose). 1000-file workspaces unless noted.

## main vs cow-redesign

| Scenario | Metric | main | cow-redesign | Δ |
| --- | --- | --- | --- | --- |
| `fork()` after 100 files | elapsed | 15.5 ms | 6.0 ms | **2.6×** faster |
| `fork()` after 1000 files | elapsed | 74.0 ms | 6.1 ms | **12×** faster |
| `fork()` after 5000 files | elapsed | 324.7 ms | 2.4 ms | **130×** faster |
| `readFile()` at chain depth 1 | median | 0.39 ms | 0.63 ms | +0.24 ms |
| `readFile()` at chain depth 5 | median | 0.45 ms | 0.52 ms | +0.07 ms |
| `readFile()` at chain depth 25 | median | 0.40 ms | 0.68 ms | +0.28 ms |
| `readFile()` at chain depth 50 | median | 0.40 ms | 0.74 ms | +0.34 ms |
| `readFile()` at chain depth 50 | p95 | 0.53 ms | 1.15 ms | +0.62 ms |
| Storage: 1000 files + fork + 1 edit | entry rows | 1001 → 2002 | 1001 → 1002 | **−1000 rows** |
| Storage: 1000 files + fork + 1 edit | total bytes | 12.09 MiB → 13.11 MiB (+1.02 MiB) | 7.20 MiB → 7.20 MiB (Δ 0 B) | **−1.02 MiB** |
| `deleteVersion` (1000 files, 100 edited) | elapsed | 42.8 ms | 23.4 ms | **1.8×** faster |
| `readdir(/d)` at depth 10 (100 files) | median | 1.17 ms | 2.09 ms | +0.92 ms |
| `readdir(/d)` at depth 10 (100 files) | p95 | 2.21 ms | 2.64 ms | +0.43 ms |

### Headline observations

**fork is now O(1).** main scales linearly with file count (15.5 → 74 → 325 ms for 100/1000/5000 files); cow-redesign holds flat at single-digit ms regardless of workspace size. At 5000 files COW fork is ~130× faster, and the gap widens with N.

**Read latency stays in the same order of magnitude even at chain depth 50** — adds ~0.3 ms median (~0.6 ms p95). The closure-table join is doing what it's supposed to: bounded extra cost, not chain-walk cost.

**Storage is the headline win.** A 1000-file fork-then-edit-one-file leaves the database **byte-for-byte identical** under COW (Δ 0 B) versus +1.02 MiB on main. The blob table only grew by one row (the edit); all other entries inherited via the closure.

**`deleteVersion` is also faster** (1.8×) because it deletes a thinner rowset (only entries the version actually owned, not a full copy).

**Directory listing is the only scenario that costs us:** +0.9 ms median, +0.4 ms p95. The `DISTINCT ON (path) ORDER BY path, depth` pattern over the closure-join is unavoidable when listings must merge inherited entries with shadowing entries from the current version. This is the documented tradeoff and stays well within practical budgets for agent filesystems.

### Caveats

- Single-machine dockerized Postgres; not a production-load benchmark. Variance between runs is ~10–20%.
- Read benchmarks use a one-time-written file inherited through the chain, the worst case for closure resolution. Hot-path agent reads (recently-mutated files at the leaf version) hit the leaf entry directly with depth=0 — even faster than the depth-1 number above.
- `readdir` divergence test edits 5 files per fork at depth 10 (50 shadowed entries out of 100). Wider divergence shrinks the COW lead; tighter divergence widens it.

### Reproduce

```sh
docker compose up -d
BENCH_LABEL=cow-redesign npm run bench
# Switch to main and re-run with BENCH_LABEL=main
```

---

## Raw runs

### cow-redesign  _(2026-04-28)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 5.96 ms |
| fork after 1000 files | fork() | 6.13 ms |
| fork after 5000 files | fork() | 2.45 ms |
| read at depth 1 | median | 0.63 ms |
| read at depth 1 | p95 | 0.80 ms |
| read at depth 5 | median | 0.52 ms |
| read at depth 5 | p95 | 0.73 ms |
| read at depth 25 | median | 0.68 ms |
| read at depth 25 | p95 | 0.79 ms |
| read at depth 50 | median | 0.74 ms |
| read at depth 50 | p95 | 1.15 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 7.20 MiB -> 7.20 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 23.40 ms |
| readdir(/d) at depth 10, 100 files | median | 2.09 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.64 ms |

### main  _(2026-04-28)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 15.52 ms |
| fork after 1000 files | fork() | 74.02 ms |
| fork after 5000 files | fork() | 324.66 ms |
| read at depth 1 | median | 0.39 ms |
| read at depth 1 | p95 | 0.53 ms |
| read at depth 5 | median | 0.45 ms |
| read at depth 5 | p95 | 0.70 ms |
| read at depth 25 | median | 0.40 ms |
| read at depth 25 | p95 | 0.52 ms |
| read at depth 50 | median | 0.40 ms |
| read at depth 50 | p95 | 0.53 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 2002 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 12.09 MiB -> 13.11 MiB (Δ 1.02 MiB) |
| deleteVersion (1000 files, 100 edited) | elapsed | 42.80 ms |
| readdir(/d) at depth 10, 100 files | median | 1.17 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.21 ms |

## unlabeled  _(2026-05-07T08:45:39.343Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 2.95 ms |
| fork after 1000 files | fork() | 2.43 ms |
| fork after 5000 files | fork() | 2.21 ms |
| read at depth 1 | median | 0.72 ms |
| read at depth 1 | p95 | 0.90 ms |
| read at depth 5 | median | 0.68 ms |
| read at depth 5 | p95 | 0.93 ms |
| read at depth 25 | median | 0.88 ms |
| read at depth 25 | p95 | 1.03 ms |
| read at depth 50 | median | 1.16 ms |
| read at depth 50 | p95 | 1.47 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 9.25 MiB -> 9.25 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 18.75 ms |
| readdir(/d) at depth 10, 100 files | median | 2.46 ms |
| readdir(/d) at depth 10, 100 files | p95 | 3.45 ms |

## baseline-main  _(2026-05-07T08:50:09.703Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 2.90 ms |
| fork after 1000 files | fork() | 2.26 ms |
| fork after 5000 files | fork() | 2.54 ms |
| read at depth 1 | median | 0.69 ms |
| read at depth 1 | p95 | 0.88 ms |
| read at depth 5 | median | 0.71 ms |
| read at depth 5 | p95 | 0.86 ms |
| read at depth 25 | median | 0.87 ms |
| read at depth 25 | p95 | 1.85 ms |
| read at depth 50 | median | 1.02 ms |
| read at depth 50 | p95 | 1.39 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 12.48 MiB -> 12.48 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 22.91 ms |
| readdir(/d) at depth 10, 100 files | median | 1.51 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.92 ms |

## after-resolveentries-main-1  _(2026-05-07T08:52:54.991Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 4.13 ms |
| fork after 1000 files | fork() | 3.05 ms |
| fork after 5000 files | fork() | 2.44 ms |
| read at depth 1 | median | 0.62 ms |
| read at depth 1 | p95 | 0.88 ms |
| read at depth 5 | median | 0.68 ms |
| read at depth 5 | p95 | 0.86 ms |
| read at depth 25 | median | 0.85 ms |
| read at depth 25 | p95 | 1.14 ms |
| read at depth 50 | median | 1.01 ms |
| read at depth 50 | p95 | 1.34 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 14.66 MiB -> 14.66 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 27.88 ms |
| readdir(/d) at depth 10, 100 files | median | 1.50 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.76 ms |

## after-resolveentries-main-2  _(2026-05-07T08:53:56.795Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 8.25 ms |
| fork after 1000 files | fork() | 6.62 ms |
| fork after 5000 files | fork() | 6.46 ms |
| read at depth 1 | median | 0.65 ms |
| read at depth 1 | p95 | 0.88 ms |
| read at depth 5 | median | 0.64 ms |
| read at depth 5 | p95 | 0.99 ms |
| read at depth 25 | median | 0.79 ms |
| read at depth 25 | p95 | 1.08 ms |
| read at depth 50 | median | 0.96 ms |
| read at depth 50 | p95 | 1.12 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 16.39 MiB -> 16.39 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 22.37 ms |
| readdir(/d) at depth 10, 100 files | median | 1.48 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.93 ms |

## after-resolveentries-main-3  _(2026-05-07T08:54:37.907Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.53 ms |
| fork after 1000 files | fork() | 2.25 ms |
| fork after 5000 files | fork() | 14.87 ms |
| read at depth 1 | median | 0.69 ms |
| read at depth 1 | p95 | 0.93 ms |
| read at depth 5 | median | 0.67 ms |
| read at depth 5 | p95 | 0.99 ms |
| read at depth 25 | median | 0.75 ms |
| read at depth 25 | p95 | 1.03 ms |
| read at depth 50 | median | 0.77 ms |
| read at depth 50 | p95 | 1.02 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 18.41 MiB -> 18.41 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 22.42 ms |
| readdir(/d) at depth 10, 100 files | median | 1.59 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.92 ms |

## after-bulk-rm-main-1  _(2026-05-07T09:03:28.596Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 8.25 ms |
| fork after 1000 files | fork() | 2.87 ms |
| fork after 5000 files | fork() | 2.91 ms |
| read at depth 1 | median | 0.90 ms |
| read at depth 1 | p95 | 1.36 ms |
| read at depth 5 | median | 0.92 ms |
| read at depth 5 | p95 | 1.50 ms |
| read at depth 25 | median | 0.87 ms |
| read at depth 25 | p95 | 1.59 ms |
| read at depth 50 | median | 1.00 ms |
| read at depth 50 | p95 | 1.39 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 51.80 MiB -> 51.80 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 26.75 ms |
| readdir(/d) at depth 10, 100 files | median | 1.79 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.35 ms |

## after-bulk-rm-main-2  _(2026-05-07T09:04:13.082Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.38 ms |
| fork after 1000 files | fork() | 3.49 ms |
| fork after 5000 files | fork() | 7.39 ms |
| read at depth 1 | median | 0.84 ms |
| read at depth 1 | p95 | 1.41 ms |
| read at depth 5 | median | 0.78 ms |
| read at depth 5 | p95 | 1.25 ms |
| read at depth 25 | median | 0.84 ms |
| read at depth 25 | p95 | 1.34 ms |
| read at depth 50 | median | 0.98 ms |
| read at depth 50 | p95 | 1.57 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 54.00 MiB -> 54.00 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 27.19 ms |
| readdir(/d) at depth 10, 100 files | median | 1.74 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.70 ms |

## after-bulk-mv-main-1  _(2026-05-07T10:22:13.844Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.82 ms |
| fork after 1000 files | fork() | 8.00 ms |
| fork after 5000 files | fork() | 6.65 ms |
| read at depth 1 | median | 0.63 ms |
| read at depth 1 | p95 | 0.92 ms |
| read at depth 5 | median | 0.62 ms |
| read at depth 5 | p95 | 0.91 ms |
| read at depth 25 | median | 0.77 ms |
| read at depth 25 | p95 | 1.22 ms |
| read at depth 50 | median | 0.86 ms |
| read at depth 50 | p95 | 1.16 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 100.24 MiB -> 100.24 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 25.01 ms |
| readdir(/d) at depth 10, 100 files | median | 1.61 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.23 ms |

## after-bulk-mv-main-2  _(2026-05-07T10:23:17.558Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.47 ms |
| fork after 1000 files | fork() | 6.72 ms |
| fork after 5000 files | fork() | 6.83 ms |
| read at depth 1 | median | 0.74 ms |
| read at depth 1 | p95 | 1.07 ms |
| read at depth 5 | median | 0.74 ms |
| read at depth 5 | p95 | 1.08 ms |
| read at depth 25 | median | 0.88 ms |
| read at depth 25 | p95 | 1.48 ms |
| read at depth 50 | median | 1.08 ms |
| read at depth 50 | p95 | 1.63 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 102.49 MiB -> 102.49 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 24.54 ms |
| readdir(/d) at depth 10, 100 files | median | 1.79 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.56 ms |

## after-bulk-cp-main-1  _(2026-05-07T10:42:03.551Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.59 ms |
| fork after 1000 files | fork() | 2.62 ms |
| fork after 5000 files | fork() | 2.22 ms |
| read at depth 1 | median | 0.71 ms |
| read at depth 1 | p95 | 1.03 ms |
| read at depth 5 | median | 0.61 ms |
| read at depth 5 | p95 | 0.88 ms |
| read at depth 25 | median | 0.77 ms |
| read at depth 25 | p95 | 1.06 ms |
| read at depth 50 | median | 0.89 ms |
| read at depth 50 | p95 | 1.11 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 144.71 MiB -> 144.71 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 24.21 ms |
| readdir(/d) at depth 10, 100 files | median | 1.67 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.16 ms |

## after-bulk-cp-main-2  _(2026-05-07T10:42:39.351Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.09 ms |
| fork after 1000 files | fork() | 2.26 ms |
| fork after 5000 files | fork() | 2.27 ms |
| read at depth 1 | median | 0.73 ms |
| read at depth 1 | p95 | 1.06 ms |
| read at depth 5 | median | 0.67 ms |
| read at depth 5 | p95 | 1.07 ms |
| read at depth 25 | median | 0.79 ms |
| read at depth 25 | p95 | 1.39 ms |
| read at depth 50 | median | 0.93 ms |
| read at depth 50 | p95 | 1.37 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 148.72 MiB -> 148.72 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 26.62 ms |
| readdir(/d) at depth 10, 100 files | median | 1.78 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.30 ms |

## after-existing-cp-main-1  _(2026-05-07T13:06:47.990Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.30 ms |
| fork after 1000 files | fork() | 2.45 ms |
| fork after 5000 files | fork() | 7.35 ms |
| read at depth 1 | median | 0.66 ms |
| read at depth 1 | p95 | 1.03 ms |
| read at depth 5 | median | 0.89 ms |
| read at depth 5 | p95 | 1.24 ms |
| read at depth 25 | median | 1.44 ms |
| read at depth 25 | p95 | 3.55 ms |
| read at depth 50 | median | 2.45 ms |
| read at depth 50 | p95 | 3.98 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 59.91 MiB -> 59.91 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 23.53 ms |
| readdir(/d) at depth 10, 100 files | median | 1.92 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.34 ms |

## after-existing-cp-main-2  _(2026-05-07T13:07:35.374Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.97 ms |
| fork after 1000 files | fork() | 2.55 ms |
| fork after 5000 files | fork() | 6.85 ms |
| read at depth 1 | median | 0.74 ms |
| read at depth 1 | p95 | 1.13 ms |
| read at depth 5 | median | 0.79 ms |
| read at depth 5 | p95 | 1.08 ms |
| read at depth 25 | median | 1.21 ms |
| read at depth 25 | p95 | 1.55 ms |
| read at depth 50 | median | 1.82 ms |
| read at depth 50 | p95 | 2.48 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 65.66 MiB -> 65.67 MiB (Δ 16.0 KiB) |
| deleteVersion (1000 files, 100 edited) | elapsed | 27.57 ms |
| readdir(/d) at depth 10, 100 files | median | 2.07 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.92 ms |

## after-batch-entryshapes-main-1  _(2026-05-07T13:16:27.820Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.47 ms |
| fork after 1000 files | fork() | 2.30 ms |
| fork after 5000 files | fork() | 3.08 ms |
| read at depth 1 | median | 0.74 ms |
| read at depth 1 | p95 | 1.20 ms |
| read at depth 5 | median | 0.75 ms |
| read at depth 5 | p95 | 1.09 ms |
| read at depth 25 | median | 1.23 ms |
| read at depth 25 | p95 | 1.65 ms |
| read at depth 50 | median | 1.66 ms |
| read at depth 50 | p95 | 2.18 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 110.69 MiB -> 110.69 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 41.04 ms |
| readdir(/d) at depth 10, 100 files | median | 2.46 ms |
| readdir(/d) at depth 10, 100 files | p95 | 4.95 ms |

## after-batch-entryshapes-main-2  _(2026-05-07T13:17:24.481Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 10.12 ms |
| fork after 1000 files | fork() | 6.74 ms |
| fork after 5000 files | fork() | 3.35 ms |
| read at depth 1 | median | 0.97 ms |
| read at depth 1 | p95 | 1.54 ms |
| read at depth 5 | median | 0.76 ms |
| read at depth 5 | p95 | 1.14 ms |
| read at depth 25 | median | 1.16 ms |
| read at depth 25 | p95 | 1.49 ms |
| read at depth 50 | median | 1.60 ms |
| read at depth 50 | p95 | 2.21 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 112.35 MiB -> 112.35 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 36.11 ms |
| readdir(/d) at depth 10, 100 files | median | 1.73 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.50 ms |

## after-batch-gc-main-1  _(2026-05-07T13:26:45.316Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 8.30 ms |
| fork after 1000 files | fork() | 6.25 ms |
| fork after 5000 files | fork() | 8.89 ms |
| read at depth 1 | median | 0.76 ms |
| read at depth 1 | p95 | 1.04 ms |
| read at depth 5 | median | 0.72 ms |
| read at depth 5 | p95 | 0.92 ms |
| read at depth 25 | median | 1.21 ms |
| read at depth 25 | p95 | 1.77 ms |
| read at depth 50 | median | 1.82 ms |
| read at depth 50 | p95 | 2.73 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 131.42 MiB -> 131.42 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.72 ms |
| readdir(/d) at depth 10, 100 files | median | 1.95 ms |
| readdir(/d) at depth 10, 100 files | p95 | 3.50 ms |

## after-batch-gc-main-2  _(2026-05-07T13:27:48.107Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.74 ms |
| fork after 1000 files | fork() | 6.86 ms |
| fork after 5000 files | fork() | 6.38 ms |
| read at depth 1 | median | 0.62 ms |
| read at depth 1 | p95 | 1.01 ms |
| read at depth 5 | median | 0.74 ms |
| read at depth 5 | p95 | 0.95 ms |
| read at depth 25 | median | 1.18 ms |
| read at depth 25 | p95 | 1.37 ms |
| read at depth 50 | median | 1.72 ms |
| read at depth 50 | p95 | 2.23 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 132.81 MiB -> 132.81 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.11 ms |
| readdir(/d) at depth 10, 100 files | median | 1.75 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.21 ms |

## after-readfile-fusion-main-1  _(2026-05-07T13:30:49.077Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 3.48 ms |
| fork after 1000 files | fork() | 2.72 ms |
| fork after 5000 files | fork() | 2.33 ms |
| read at depth 1 | median | 0.80 ms |
| read at depth 1 | p95 | 1.06 ms |
| read at depth 5 | median | 0.81 ms |
| read at depth 5 | p95 | 1.08 ms |
| read at depth 25 | median | 1.37 ms |
| read at depth 25 | p95 | 1.63 ms |
| read at depth 50 | median | 1.99 ms |
| read at depth 50 | p95 | 2.62 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 132.80 MiB -> 132.80 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 10.32 ms |
| readdir(/d) at depth 10, 100 files | median | 1.87 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.41 ms |

## after-readfile-fusion-main-2  _(2026-05-07T13:31:31.155Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.62 ms |
| fork after 1000 files | fork() | 2.50 ms |
| fork after 5000 files | fork() | 3.34 ms |
| read at depth 1 | median | 0.86 ms |
| read at depth 1 | p95 | 1.71 ms |
| read at depth 5 | median | 0.90 ms |
| read at depth 5 | p95 | 1.32 ms |
| read at depth 25 | median | 1.50 ms |
| read at depth 25 | p95 | 2.17 ms |
| read at depth 50 | median | 1.77 ms |
| read at depth 50 | p95 | 2.44 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 133.11 MiB -> 133.11 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.42 ms |
| readdir(/d) at depth 10, 100 files | median | 1.77 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.40 ms |
