# bash-gres bench results

PostgreSQL on `localhost:5434` (docker compose). 1000-file workspaces unless noted.

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

## baseline-refactor-1  _(2026-05-07T14:22:56.064Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 4.37 ms |
| fork after 1000 files | fork() | 2.28 ms |
| fork after 5000 files | fork() | 2.99 ms |
| read at depth 1 | median | 0.65 ms |
| read at depth 1 | p95 | 0.81 ms |
| read at depth 5 | median | 0.74 ms |
| read at depth 5 | p95 | 0.86 ms |
| read at depth 25 | median | 1.24 ms |
| read at depth 25 | p95 | 1.41 ms |
| read at depth 50 | median | 1.83 ms |
| read at depth 50 | p95 | 2.25 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 134.11 MiB -> 134.11 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.61 ms |
| readdir(/d) at depth 10, 100 files | median | 1.50 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.90 ms |

## baseline-refactor-2  _(2026-05-07T14:23:30.243Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.54 ms |
| fork after 1000 files | fork() | 2.25 ms |
| fork after 5000 files | fork() | 2.48 ms |
| read at depth 1 | median | 0.67 ms |
| read at depth 1 | p95 | 0.90 ms |
| read at depth 5 | median | 0.74 ms |
| read at depth 5 | p95 | 0.88 ms |
| read at depth 25 | median | 1.14 ms |
| read at depth 25 | p95 | 1.45 ms |
| read at depth 50 | median | 1.62 ms |
| read at depth 50 | p95 | 1.95 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 134.74 MiB -> 134.74 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 7.93 ms |
| readdir(/d) at depth 10, 100 files | median | 1.52 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.89 ms |

## baseline-refactor-3  _(2026-05-07T14:24:13.263Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.08 ms |
| fork after 1000 files | fork() | 2.21 ms |
| fork after 5000 files | fork() | 3.12 ms |
| read at depth 1 | median | 0.73 ms |
| read at depth 1 | p95 | 0.97 ms |
| read at depth 5 | median | 0.82 ms |
| read at depth 5 | p95 | 1.15 ms |
| read at depth 25 | median | 1.22 ms |
| read at depth 25 | p95 | 1.45 ms |
| read at depth 50 | median | 1.73 ms |
| read at depth 50 | p95 | 2.49 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 134.98 MiB -> 134.98 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.25 ms |
| readdir(/d) at depth 10, 100 files | median | 1.58 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.96 ms |

## after-flip-1  _(2026-05-07T14:29:19.677Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.58 ms |
| fork after 1000 files | fork() | 2.28 ms |
| fork after 5000 files | fork() | 2.99 ms |
| read at depth 1 | median | 0.83 ms |
| read at depth 1 | p95 | 0.92 ms |
| read at depth 5 | median | 0.95 ms |
| read at depth 5 | p95 | 1.03 ms |
| read at depth 25 | median | 1.46 ms |
| read at depth 25 | p95 | 1.63 ms |
| read at depth 50 | median | 2.31 ms |
| read at depth 50 | p95 | 2.59 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 134.32 MiB -> 134.32 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.01 ms |
| readdir(/d) at depth 10, 100 files | median | 1.52 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.91 ms |

## after-flip-cte-1  _(2026-05-07T14:33:02.358Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.75 ms |
| fork after 1000 files | fork() | 2.52 ms |
| fork after 5000 files | fork() | 19.98 ms |
| read at depth 1 | median | 0.86 ms |
| read at depth 1 | p95 | 1.01 ms |
| read at depth 5 | median | 0.78 ms |
| read at depth 5 | p95 | 1.43 ms |
| read at depth 25 | median | 0.82 ms |
| read at depth 25 | p95 | 1.02 ms |
| read at depth 50 | median | 0.74 ms |
| read at depth 50 | p95 | 0.92 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 134.48 MiB -> 134.48 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 7.95 ms |
| readdir(/d) at depth 10, 100 files | median | 1.28 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.76 ms |

## after-flip-cte-2  _(2026-05-07T14:33:45.578Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.94 ms |
| fork after 1000 files | fork() | 2.36 ms |
| fork after 5000 files | fork() | 6.96 ms |
| read at depth 1 | median | 0.78 ms |
| read at depth 1 | p95 | 1.04 ms |
| read at depth 5 | median | 0.76 ms |
| read at depth 5 | p95 | 1.16 ms |
| read at depth 25 | median | 0.87 ms |
| read at depth 25 | p95 | 2.19 ms |
| read at depth 50 | median | 0.75 ms |
| read at depth 50 | p95 | 1.06 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 134.48 MiB -> 134.48 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.92 ms |
| readdir(/d) at depth 10, 100 files | median | 1.24 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.57 ms |

## after-flip-cte-3  _(2026-05-07T14:34:20.207Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.87 ms |
| fork after 1000 files | fork() | 2.25 ms |
| fork after 5000 files | fork() | 4.83 ms |
| read at depth 1 | median | 0.77 ms |
| read at depth 1 | p95 | 1.11 ms |
| read at depth 5 | median | 0.89 ms |
| read at depth 5 | p95 | 1.25 ms |
| read at depth 25 | median | 0.89 ms |
| read at depth 25 | p95 | 1.14 ms |
| read at depth 50 | median | 0.78 ms |
| read at depth 50 | p95 | 1.02 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 134.58 MiB -> 134.58 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.28 ms |
| readdir(/d) at depth 10, 100 files | median | 1.19 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.43 ms |

## after-readonly-readfile  _(2026-05-07T15:04:50.772Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.14 ms |
| fork after 1000 files | fork() | 2.73 ms |
| fork after 5000 files | fork() | 3.00 ms |
| read at depth 1 | median | 0.61 ms |
| read at depth 1 | p95 | 0.94 ms |
| read at depth 5 | median | 0.64 ms |
| read at depth 5 | p95 | 0.90 ms |
| read at depth 25 | median | 0.60 ms |
| read at depth 25 | p95 | 0.83 ms |
| read at depth 50 | median | 0.59 ms |
| read at depth 50 | p95 | 0.87 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 134.75 MiB -> 134.75 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.32 ms |
| readdir(/d) at depth 10, 100 files | median | 1.33 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.85 ms |

## after-readonly-1  _(2026-05-07T15:08:10.004Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.69 ms |
| fork after 1000 files | fork() | 2.34 ms |
| fork after 5000 files | fork() | 2.44 ms |
| read at depth 1 | median | 0.59 ms |
| read at depth 1 | p95 | 0.89 ms |
| read at depth 5 | median | 0.54 ms |
| read at depth 5 | p95 | 0.65 ms |
| read at depth 25 | median | 0.57 ms |
| read at depth 25 | p95 | 0.72 ms |
| read at depth 50 | median | 0.55 ms |
| read at depth 50 | p95 | 0.69 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 134.66 MiB -> 134.66 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.89 ms |
| readdir(/d) at depth 10, 100 files | median | 1.07 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.60 ms |

## after-readonly-2  _(2026-05-07T15:08:55.668Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 3.12 ms |
| fork after 1000 files | fork() | 2.52 ms |
| fork after 5000 files | fork() | 9.69 ms |
| read at depth 1 | median | 0.55 ms |
| read at depth 1 | p95 | 0.99 ms |
| read at depth 5 | median | 0.54 ms |
| read at depth 5 | p95 | 0.61 ms |
| read at depth 25 | median | 0.51 ms |
| read at depth 25 | p95 | 0.65 ms |
| read at depth 50 | median | 0.52 ms |
| read at depth 50 | p95 | 0.66 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 134.66 MiB -> 134.66 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.23 ms |
| readdir(/d) at depth 10, 100 files | median | 1.05 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.11 ms |

## after-readonly-3  _(2026-05-07T15:09:39.343Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.73 ms |
| fork after 1000 files | fork() | 2.64 ms |
| fork after 5000 files | fork() | 21.52 ms |
| read at depth 1 | median | 0.52 ms |
| read at depth 1 | p95 | 0.63 ms |
| read at depth 5 | median | 0.54 ms |
| read at depth 5 | p95 | 0.67 ms |
| read at depth 25 | median | 0.53 ms |
| read at depth 25 | p95 | 0.63 ms |
| read at depth 50 | median | 0.56 ms |
| read at depth 50 | p95 | 0.83 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 134.64 MiB -> 134.64 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.35 ms |
| readdir(/d) at depth 10, 100 files | median | 1.06 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.42 ms |

## after-ops-readonly-1  _(2026-05-07T15:16:47.793Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.68 ms |
| fork after 1000 files | fork() | 2.26 ms |
| fork after 5000 files | fork() | 7.65 ms |
| read at depth 1 | median | 0.72 ms |
| read at depth 1 | p95 | 1.13 ms |
| read at depth 5 | median | 0.62 ms |
| read at depth 5 | p95 | 1.07 ms |
| read at depth 25 | median | 0.58 ms |
| read at depth 25 | p95 | 0.96 ms |
| read at depth 50 | median | 0.60 ms |
| read at depth 50 | p95 | 0.86 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 134.70 MiB -> 134.70 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 7.65 ms |
| readdir(/d) at depth 10, 100 files | median | 1.17 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.72 ms |

## after-ops-readonly-2  _(2026-05-07T15:17:37.333Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.17 ms |
| fork after 1000 files | fork() | 2.64 ms |
| fork after 5000 files | fork() | 6.86 ms |
| read at depth 1 | median | 0.55 ms |
| read at depth 1 | p95 | 0.96 ms |
| read at depth 5 | median | 0.55 ms |
| read at depth 5 | p95 | 0.98 ms |
| read at depth 25 | median | 0.59 ms |
| read at depth 25 | p95 | 0.87 ms |
| read at depth 50 | median | 0.88 ms |
| read at depth 50 | p95 | 1.41 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 135.40 MiB -> 135.40 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.21 ms |
| readdir(/d) at depth 10, 100 files | median | 1.15 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.50 ms |

## after-ops-readonly-3  _(2026-05-07T15:18:22.101Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.64 ms |
| fork after 1000 files | fork() | 2.22 ms |
| fork after 5000 files | fork() | 3.42 ms |
| read at depth 1 | median | 0.58 ms |
| read at depth 1 | p95 | 0.72 ms |
| read at depth 5 | median | 0.56 ms |
| read at depth 5 | p95 | 0.71 ms |
| read at depth 25 | median | 0.58 ms |
| read at depth 25 | p95 | 0.70 ms |
| read at depth 50 | median | 0.61 ms |
| read at depth 50 | p95 | 0.88 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 135.63 MiB -> 135.63 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 9.39 ms |
| readdir(/d) at depth 10, 100 files | median | 1.16 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.87 ms |

## after-readbuffer-fuse-1  _(2026-05-07T15:22:25.608Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.01 ms |
| fork after 1000 files | fork() | 6.62 ms |
| fork after 5000 files | fork() | 3.24 ms |
| read at depth 1 | median | 0.58 ms |
| read at depth 1 | p95 | 0.79 ms |
| read at depth 5 | median | 0.54 ms |
| read at depth 5 | p95 | 0.78 ms |
| read at depth 25 | median | 0.55 ms |
| read at depth 25 | p95 | 0.71 ms |
| read at depth 50 | median | 0.54 ms |
| read at depth 50 | p95 | 0.66 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 134.67 MiB -> 134.67 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 7.89 ms |
| readdir(/d) at depth 10, 100 files | median | 1.14 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.93 ms |

## after-readbuffer-fuse-2  _(2026-05-07T15:23:10.656Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.76 ms |
| fork after 1000 files | fork() | 2.29 ms |
| fork after 5000 files | fork() | 12.16 ms |
| read at depth 1 | median | 0.56 ms |
| read at depth 1 | p95 | 0.72 ms |
| read at depth 5 | median | 0.60 ms |
| read at depth 5 | p95 | 0.80 ms |
| read at depth 25 | median | 0.59 ms |
| read at depth 25 | p95 | 0.78 ms |
| read at depth 50 | median | 0.59 ms |
| read at depth 50 | p95 | 0.93 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 135.53 MiB -> 135.53 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.35 ms |
| readdir(/d) at depth 10, 100 files | median | 1.20 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.62 ms |

## after-readbuffer-fuse-3  _(2026-05-07T15:23:47.841Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.81 ms |
| fork after 1000 files | fork() | 2.22 ms |
| fork after 5000 files | fork() | 2.67 ms |
| read at depth 1 | median | 0.53 ms |
| read at depth 1 | p95 | 0.71 ms |
| read at depth 5 | median | 0.51 ms |
| read at depth 5 | p95 | 0.59 ms |
| read at depth 25 | median | 0.57 ms |
| read at depth 25 | p95 | 0.68 ms |
| read at depth 50 | median | 0.58 ms |
| read at depth 50 | p95 | 1.09 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 135.55 MiB -> 135.55 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 7.81 ms |
| readdir(/d) at depth 10, 100 files | median | 1.11 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.32 ms |

## after-readrange-fuse-1  _(2026-05-07T15:26:45.236Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 5.05 ms |
| fork after 1000 files | fork() | 2.83 ms |
| fork after 5000 files | fork() | 2.40 ms |
| read at depth 1 | median | 0.58 ms |
| read at depth 1 | p95 | 0.80 ms |
| read at depth 5 | median | 0.57 ms |
| read at depth 5 | p95 | 0.82 ms |
| read at depth 25 | median | 0.59 ms |
| read at depth 25 | p95 | 0.84 ms |
| read at depth 50 | median | 0.56 ms |
| read at depth 50 | p95 | 0.77 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 134.56 MiB -> 134.56 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.47 ms |
| readdir(/d) at depth 10, 100 files | median | 2.22 ms |
| readdir(/d) at depth 10, 100 files | p95 | 3.01 ms |

## after-readrange-fuse-2  _(2026-05-07T15:27:31.485Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.41 ms |
| fork after 1000 files | fork() | 2.60 ms |
| fork after 5000 files | fork() | 5.52 ms |
| read at depth 1 | median | 0.61 ms |
| read at depth 1 | p95 | 0.80 ms |
| read at depth 5 | median | 0.59 ms |
| read at depth 5 | p95 | 0.86 ms |
| read at depth 25 | median | 0.58 ms |
| read at depth 25 | p95 | 0.68 ms |
| read at depth 50 | median | 0.58 ms |
| read at depth 50 | p95 | 0.77 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 135.87 MiB -> 135.87 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.51 ms |
| readdir(/d) at depth 10, 100 files | median | 1.23 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.71 ms |

## after-readrange-fuse-3  _(2026-05-07T15:28:46.676Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.01 ms |
| fork after 1000 files | fork() | 2.69 ms |
| fork after 5000 files | fork() | 22.99 ms |
| read at depth 1 | median | 1.64 ms |
| read at depth 1 | p95 | 8.95 ms |
| read at depth 5 | median | 1.64 ms |
| read at depth 5 | p95 | 6.19 ms |
| read at depth 25 | median | 2.11 ms |
| read at depth 25 | p95 | 6.53 ms |
| read at depth 50 | median | 1.84 ms |
| read at depth 50 | p95 | 11.84 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 135.87 MiB -> 135.87 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.57 ms |
| readdir(/d) at depth 10, 100 files | median | 2.18 ms |
| readdir(/d) at depth 10, 100 files | p95 | 4.30 ms |

## after-readrange-fuse-4-rerun  _(2026-05-07T15:29:57.445Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 12.80 ms |
| fork after 1000 files | fork() | 9.12 ms |
| fork after 5000 files | fork() | 6.41 ms |
| read at depth 1 | median | 0.54 ms |
| read at depth 1 | p95 | 0.63 ms |
| read at depth 5 | median | 0.55 ms |
| read at depth 5 | p95 | 0.80 ms |
| read at depth 25 | median | 0.57 ms |
| read at depth 25 | p95 | 0.69 ms |
| read at depth 50 | median | 0.59 ms |
| read at depth 50 | p95 | 0.85 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 134.88 MiB -> 134.88 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.53 ms |
| readdir(/d) at depth 10, 100 files | median | 1.16 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.38 ms |

## after-readlines-fuse-1  _(2026-05-07T15:32:26.516Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 3.38 ms |
| fork after 1000 files | fork() | 2.45 ms |
| fork after 5000 files | fork() | 6.76 ms |
| read at depth 1 | median | 0.57 ms |
| read at depth 1 | p95 | 0.73 ms |
| read at depth 5 | median | 0.59 ms |
| read at depth 5 | p95 | 0.84 ms |
| read at depth 25 | median | 0.56 ms |
| read at depth 25 | p95 | 0.84 ms |
| read at depth 50 | median | 0.57 ms |
| read at depth 50 | p95 | 0.68 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 135.30 MiB -> 135.30 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 7.74 ms |
| readdir(/d) at depth 10, 100 files | median | 1.17 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.59 ms |

## after-readlines-fuse-2  _(2026-05-07T15:33:29.823Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 8.22 ms |
| fork after 1000 files | fork() | 2.48 ms |
| fork after 5000 files | fork() | 8.62 ms |
| read at depth 1 | median | 0.76 ms |
| read at depth 1 | p95 | 1.01 ms |
| read at depth 5 | median | 0.70 ms |
| read at depth 5 | p95 | 0.93 ms |
| read at depth 25 | median | 0.72 ms |
| read at depth 25 | p95 | 0.96 ms |
| read at depth 50 | median | 1.39 ms |
| read at depth 50 | p95 | 3.77 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 135.52 MiB -> 135.52 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 15.37 ms |
| readdir(/d) at depth 10, 100 files | median | 2.44 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.93 ms |

## after-readlines-fuse-3  _(2026-05-07T15:34:42.039Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.59 ms |
| fork after 1000 files | fork() | 9.05 ms |
| fork after 5000 files | fork() | 7.58 ms |
| read at depth 1 | median | 1.02 ms |
| read at depth 1 | p95 | 1.71 ms |
| read at depth 5 | median | 1.03 ms |
| read at depth 5 | p95 | 1.33 ms |
| read at depth 25 | median | 1.09 ms |
| read at depth 25 | p95 | 3.14 ms |
| read at depth 50 | median | 1.12 ms |
| read at depth 50 | p95 | 2.21 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 137.30 MiB -> 137.30 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 16.55 ms |
| readdir(/d) at depth 10, 100 files | median | 2.39 ms |
| readdir(/d) at depth 10, 100 files | p95 | 5.49 ms |

## after-readlines-fuse-4-rerun  _(2026-05-07T15:35:36.006Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 3.33 ms |
| fork after 1000 files | fork() | 2.29 ms |
| fork after 5000 files | fork() | 2.75 ms |
| read at depth 1 | median | 0.58 ms |
| read at depth 1 | p95 | 0.68 ms |
| read at depth 5 | median | 0.57 ms |
| read at depth 5 | p95 | 0.74 ms |
| read at depth 25 | median | 0.57 ms |
| read at depth 25 | p95 | 0.73 ms |
| read at depth 50 | median | 0.57 ms |
| read at depth 50 | p95 | 0.62 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 137.30 MiB -> 137.30 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 7.85 ms |
| readdir(/d) at depth 10, 100 files | median | 1.19 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.36 ms |

## after-readlines-fuse-5-rerun  _(2026-05-07T15:36:14.608Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 8.95 ms |
| fork after 1000 files | fork() | 2.36 ms |
| fork after 5000 files | fork() | 3.42 ms |
| read at depth 1 | median | 0.58 ms |
| read at depth 1 | p95 | 0.79 ms |
| read at depth 5 | median | 0.59 ms |
| read at depth 5 | p95 | 0.80 ms |
| read at depth 25 | median | 0.61 ms |
| read at depth 25 | p95 | 1.27 ms |
| read at depth 50 | median | 0.65 ms |
| read at depth 50 | p95 | 1.04 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 137.71 MiB -> 137.71 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 27.39 ms |
| readdir(/d) at depth 10, 100 files | median | 1.07 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.35 ms |

## after-fork-fuse-1  _(2026-05-07T15:39:17.784Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.86 ms |
| fork after 1000 files | fork() | 2.64 ms |
| fork after 5000 files | fork() | 2.34 ms |
| read at depth 1 | median | 0.51 ms |
| read at depth 1 | p95 | 0.68 ms |
| read at depth 5 | median | 0.51 ms |
| read at depth 5 | p95 | 0.75 ms |
| read at depth 25 | median | 0.51 ms |
| read at depth 25 | p95 | 0.66 ms |
| read at depth 50 | median | 0.54 ms |
| read at depth 50 | p95 | 0.73 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 137.84 MiB -> 137.84 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 9.08 ms |
| readdir(/d) at depth 10, 100 files | median | 1.13 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.62 ms |

## after-fork-fuse-2  _(2026-05-07T15:39:56.628Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.51 ms |
| fork after 1000 files | fork() | 3.18 ms |
| fork after 5000 files | fork() | 2.22 ms |
| read at depth 1 | median | 0.53 ms |
| read at depth 1 | p95 | 0.80 ms |
| read at depth 5 | median | 0.52 ms |
| read at depth 5 | p95 | 0.75 ms |
| read at depth 25 | median | 0.58 ms |
| read at depth 25 | p95 | 0.90 ms |
| read at depth 50 | median | 0.59 ms |
| read at depth 50 | p95 | 0.88 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 136.45 MiB -> 136.45 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 9.33 ms |
| readdir(/d) at depth 10, 100 files | median | 1.21 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.64 ms |

## after-fork-fuse-3  _(2026-05-07T15:40:35.753Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.24 ms |
| fork after 1000 files | fork() | 6.35 ms |
| fork after 5000 files | fork() | 2.29 ms |
| read at depth 1 | median | 0.49 ms |
| read at depth 1 | p95 | 0.74 ms |
| read at depth 5 | median | 0.50 ms |
| read at depth 5 | p95 | 0.67 ms |
| read at depth 25 | median | 0.51 ms |
| read at depth 25 | p95 | 0.67 ms |
| read at depth 50 | median | 0.51 ms |
| read at depth 50 | p95 | 0.70 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 136.84 MiB -> 136.84 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 14.75 ms |
| readdir(/d) at depth 10, 100 files | median | 2.57 ms |
| readdir(/d) at depth 10, 100 files | p95 | 3.78 ms |

## extended-baseline-1  _(2026-05-07T15:42:56.780Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 3.43 ms |
| fork after 1000 files | fork() | 2.18 ms |
| fork after 5000 files | fork() | 18.04 ms |
| read at depth 1 | median | 0.54 ms |
| read at depth 1 | p95 | 0.68 ms |
| read at depth 5 | median | 0.54 ms |
| read at depth 5 | p95 | 0.69 ms |
| read at depth 25 | median | 0.52 ms |
| read at depth 25 | p95 | 0.73 ms |
| read at depth 50 | median | 0.52 ms |
| read at depth 50 | p95 | 0.68 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 136.84 MiB -> 136.84 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 7.93 ms |
| readdir(/d) at depth 10, 100 files | median | 1.91 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.37 ms |
| readFileBuffer (text, 200 lines) | median | 0.53 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.75 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.51 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.67 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.53 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.63 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.71 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.95 ms |
| listVersions (6 versions) | median | 0.16 ms |
| listVersions (6 versions) | p95 | 0.25 ms |
| getUsage (50 files, depth 5) | median | 1.37 ms |
| getUsage (50 files, depth 5) | p95 | 1.60 ms |
| diff (cur vs sibling, 50 files) | median | 1.13 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.47 ms |
| writeFile (new file in existing dir) | median | 6.36 ms |
| writeFile (new file in existing dir) | p95 | 6.87 ms |
| writeFile (overwrite existing) | median | 6.31 ms |
| writeFile (overwrite existing) | p95 | 6.94 ms |

## extended-baseline-2  _(2026-05-07T15:43:50.477Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.41 ms |
| fork after 1000 files | fork() | 5.30 ms |
| fork after 5000 files | fork() | 2.43 ms |
| read at depth 1 | median | 0.52 ms |
| read at depth 1 | p95 | 0.81 ms |
| read at depth 5 | median | 0.53 ms |
| read at depth 5 | p95 | 0.66 ms |
| read at depth 25 | median | 0.52 ms |
| read at depth 25 | p95 | 0.64 ms |
| read at depth 50 | median | 0.52 ms |
| read at depth 50 | p95 | 0.76 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 136.88 MiB -> 136.88 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 7.88 ms |
| readdir(/d) at depth 10, 100 files | median | 1.04 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.37 ms |
| readFileBuffer (text, 200 lines) | median | 0.52 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.65 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.47 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.62 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.48 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.71 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.67 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.76 ms |
| listVersions (6 versions) | median | 0.18 ms |
| listVersions (6 versions) | p95 | 0.27 ms |
| getUsage (50 files, depth 5) | median | 1.10 ms |
| getUsage (50 files, depth 5) | p95 | 1.34 ms |
| diff (cur vs sibling, 50 files) | median | 0.97 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.32 ms |
| writeFile (new file in existing dir) | median | 6.23 ms |
| writeFile (new file in existing dir) | p95 | 7.00 ms |
| writeFile (overwrite existing) | median | 6.32 ms |
| writeFile (overwrite existing) | p95 | 7.37 ms |

## extended-baseline-3  _(2026-05-07T15:44:28.288Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.37 ms |
| fork after 1000 files | fork() | 2.19 ms |
| fork after 5000 files | fork() | 25.57 ms |
| read at depth 1 | median | 0.53 ms |
| read at depth 1 | p95 | 0.69 ms |
| read at depth 5 | median | 0.55 ms |
| read at depth 5 | p95 | 0.62 ms |
| read at depth 25 | median | 0.60 ms |
| read at depth 25 | p95 | 0.81 ms |
| read at depth 50 | median | 0.57 ms |
| read at depth 50 | p95 | 0.70 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 137.74 MiB -> 137.74 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 7.94 ms |
| readdir(/d) at depth 10, 100 files | median | 1.17 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.83 ms |
| readFileBuffer (text, 200 lines) | median | 0.66 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.87 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.57 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 1.49 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.49 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.66 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.70 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 1.15 ms |
| listVersions (6 versions) | median | 0.17 ms |
| listVersions (6 versions) | p95 | 0.25 ms |
| getUsage (50 files, depth 5) | median | 1.10 ms |
| getUsage (50 files, depth 5) | p95 | 1.20 ms |
| diff (cur vs sibling, 50 files) | median | 1.07 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.83 ms |
| writeFile (new file in existing dir) | median | 6.62 ms |
| writeFile (new file in existing dir) | p95 | 7.74 ms |
| writeFile (overwrite existing) | median | 6.61 ms |
| writeFile (overwrite existing) | p95 | 7.44 ms |

## after-writefile-fuse-1  _(2026-05-07T15:52:34.372Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.18 ms |
| fork after 1000 files | fork() | 5.93 ms |
| fork after 5000 files | fork() | 6.13 ms |
| read at depth 1 | median | 0.55 ms |
| read at depth 1 | p95 | 0.58 ms |
| read at depth 5 | median | 0.52 ms |
| read at depth 5 | p95 | 0.74 ms |
| read at depth 25 | median | 0.55 ms |
| read at depth 25 | p95 | 0.75 ms |
| read at depth 50 | median | 0.53 ms |
| read at depth 50 | p95 | 0.68 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 137.64 MiB -> 137.64 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.12 ms |
| readdir(/d) at depth 10, 100 files | median | 1.12 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.60 ms |
| readFileBuffer (text, 200 lines) | median | 0.55 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.74 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.51 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.75 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.51 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.69 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.73 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 1.11 ms |
| listVersions (6 versions) | median | 0.18 ms |
| listVersions (6 versions) | p95 | 0.25 ms |
| getUsage (50 files, depth 5) | median | 1.21 ms |
| getUsage (50 files, depth 5) | p95 | 1.80 ms |
| diff (cur vs sibling, 50 files) | median | 0.90 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.67 ms |
| writeFile (new file in existing dir) | median | 7.13 ms |
| writeFile (new file in existing dir) | p95 | 12.36 ms |
| writeFile (overwrite existing) | median | 7.02 ms |
| writeFile (overwrite existing) | p95 | 7.98 ms |

## after-writefile-fuse-2  _(2026-05-07T15:53:36.536Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.30 ms |
| fork after 1000 files | fork() | 5.85 ms |
| fork after 5000 files | fork() | 5.97 ms |
| read at depth 1 | median | 0.56 ms |
| read at depth 1 | p95 | 0.81 ms |
| read at depth 5 | median | 0.50 ms |
| read at depth 5 | p95 | 0.57 ms |
| read at depth 25 | median | 0.53 ms |
| read at depth 25 | p95 | 0.94 ms |
| read at depth 50 | median | 0.57 ms |
| read at depth 50 | p95 | 0.85 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 137.64 MiB -> 137.64 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.72 ms |
| readdir(/d) at depth 10, 100 files | median | 1.58 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.40 ms |
| readFileBuffer (text, 200 lines) | median | 0.54 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.73 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.50 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.71 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.47 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.59 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.66 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.84 ms |
| listVersions (6 versions) | median | 0.14 ms |
| listVersions (6 versions) | p95 | 0.18 ms |
| getUsage (50 files, depth 5) | median | 1.08 ms |
| getUsage (50 files, depth 5) | p95 | 1.30 ms |
| diff (cur vs sibling, 50 files) | median | 0.88 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.08 ms |
| writeFile (new file in existing dir) | median | 6.65 ms |
| writeFile (new file in existing dir) | p95 | 7.31 ms |
| writeFile (overwrite existing) | median | 6.65 ms |
| writeFile (overwrite existing) | p95 | 7.45 ms |

## after-writefile-fuse-3  _(2026-05-07T15:54:37.606Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.35 ms |
| fork after 1000 files | fork() | 5.61 ms |
| fork after 5000 files | fork() | 6.09 ms |
| read at depth 1 | median | 0.49 ms |
| read at depth 1 | p95 | 0.59 ms |
| read at depth 5 | median | 0.52 ms |
| read at depth 5 | p95 | 0.66 ms |
| read at depth 25 | median | 0.51 ms |
| read at depth 25 | p95 | 0.71 ms |
| read at depth 50 | median | 0.50 ms |
| read at depth 50 | p95 | 0.55 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 137.66 MiB -> 137.66 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.44 ms |
| readdir(/d) at depth 10, 100 files | median | 1.08 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.34 ms |
| readFileBuffer (text, 200 lines) | median | 0.52 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.57 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.50 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.86 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.49 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.73 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.68 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.98 ms |
| listVersions (6 versions) | median | 0.14 ms |
| listVersions (6 versions) | p95 | 0.19 ms |
| getUsage (50 files, depth 5) | median | 1.10 ms |
| getUsage (50 files, depth 5) | p95 | 1.21 ms |
| diff (cur vs sibling, 50 files) | median | 0.89 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.20 ms |
| writeFile (new file in existing dir) | median | 6.53 ms |
| writeFile (new file in existing dir) | p95 | 7.96 ms |
| writeFile (overwrite existing) | median | 6.58 ms |
| writeFile (overwrite existing) | p95 | 7.15 ms |

## after-writefile-fuse-4  _(2026-05-07T15:55:37.695Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.23 ms |
| fork after 1000 files | fork() | 2.33 ms |
| fork after 5000 files | fork() | 2.51 ms |
| read at depth 1 | median | 0.50 ms |
| read at depth 1 | p95 | 0.62 ms |
| read at depth 5 | median | 0.51 ms |
| read at depth 5 | p95 | 0.81 ms |
| read at depth 25 | median | 0.51 ms |
| read at depth 25 | p95 | 0.93 ms |
| read at depth 50 | median | 0.55 ms |
| read at depth 50 | p95 | 0.63 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 137.66 MiB -> 137.66 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 9.02 ms |
| readdir(/d) at depth 10, 100 files | median | 1.11 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.34 ms |
| readFileBuffer (text, 200 lines) | median | 0.51 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.65 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.49 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.63 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.49 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.64 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.63 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.79 ms |
| listVersions (6 versions) | median | 0.17 ms |
| listVersions (6 versions) | p95 | 0.21 ms |
| getUsage (50 files, depth 5) | median | 1.06 ms |
| getUsage (50 files, depth 5) | p95 | 1.42 ms |
| diff (cur vs sibling, 50 files) | median | 0.90 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.13 ms |
| writeFile (new file in existing dir) | median | 6.55 ms |
| writeFile (new file in existing dir) | p95 | 7.20 ms |
| writeFile (overwrite existing) | median | 6.66 ms |
| writeFile (overwrite existing) | p95 | 7.33 ms |

## after-writefile-fuse-5  _(2026-05-07T15:56:15.887Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.77 ms |
| fork after 1000 files | fork() | 2.32 ms |
| fork after 5000 files | fork() | 2.25 ms |
| read at depth 1 | median | 0.50 ms |
| read at depth 1 | p95 | 0.53 ms |
| read at depth 5 | median | 0.54 ms |
| read at depth 5 | p95 | 0.70 ms |
| read at depth 25 | median | 0.51 ms |
| read at depth 25 | p95 | 0.63 ms |
| read at depth 50 | median | 0.50 ms |
| read at depth 50 | p95 | 0.58 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 138.05 MiB -> 138.05 MiB (Δ 8.0 KiB) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.02 ms |
| readdir(/d) at depth 10, 100 files | median | 1.00 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.11 ms |
| readFileBuffer (text, 200 lines) | median | 0.48 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.62 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.48 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.62 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.54 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.81 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.70 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.85 ms |
| listVersions (6 versions) | median | 0.15 ms |
| listVersions (6 versions) | p95 | 0.33 ms |
| getUsage (50 files, depth 5) | median | 1.14 ms |
| getUsage (50 files, depth 5) | p95 | 1.50 ms |
| diff (cur vs sibling, 50 files) | median | 0.87 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.03 ms |
| writeFile (new file in existing dir) | median | 6.36 ms |
| writeFile (new file in existing dir) | p95 | 6.82 ms |
| writeFile (overwrite existing) | median | 22.13 ms |
| writeFile (overwrite existing) | p95 | 34.44 ms |

## after-writefile-fuse-v2-1  _(2026-05-07T15:59:47.337Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.37 ms |
| fork after 1000 files | fork() | 2.11 ms |
| fork after 5000 files | fork() | 2.03 ms |
| read at depth 1 | median | 0.51 ms |
| read at depth 1 | p95 | 0.63 ms |
| read at depth 5 | median | 0.50 ms |
| read at depth 5 | p95 | 0.60 ms |
| read at depth 25 | median | 0.51 ms |
| read at depth 25 | p95 | 0.77 ms |
| read at depth 50 | median | 0.52 ms |
| read at depth 50 | p95 | 0.69 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 138.28 MiB -> 138.28 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 4.53 ms |
| readdir(/d) at depth 10, 100 files | median | 1.79 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.06 ms |
| readFileBuffer (text, 200 lines) | median | 0.50 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.57 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.52 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.77 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.49 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.61 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.67 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.87 ms |
| listVersions (6 versions) | median | 0.13 ms |
| listVersions (6 versions) | p95 | 0.16 ms |
| getUsage (50 files, depth 5) | median | 1.04 ms |
| getUsage (50 files, depth 5) | p95 | 1.10 ms |
| diff (cur vs sibling, 50 files) | median | 0.88 ms |
| diff (cur vs sibling, 50 files) | p95 | 0.98 ms |
| writeFile (new file in existing dir) | median | 2.82 ms |
| writeFile (new file in existing dir) | p95 | 3.24 ms |
| writeFile (overwrite existing) | median | 6.50 ms |
| writeFile (overwrite existing) | p95 | 7.18 ms |

## after-writefile-fuse-v2-2  _(2026-05-07T16:01:13.724Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.04 ms |
| fork after 1000 files | fork() | 5.92 ms |
| fork after 5000 files | fork() | 2.07 ms |
| read at depth 1 | median | 0.51 ms |
| read at depth 1 | p95 | 0.71 ms |
| read at depth 5 | median | 0.51 ms |
| read at depth 5 | p95 | 0.61 ms |
| read at depth 25 | median | 0.52 ms |
| read at depth 25 | p95 | 0.57 ms |
| read at depth 50 | median | 0.53 ms |
| read at depth 50 | p95 | 0.69 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 137.74 MiB -> 137.74 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 10.48 ms |
| readdir(/d) at depth 10, 100 files | median | 1.06 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.36 ms |
| readFileBuffer (text, 200 lines) | median | 0.50 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.62 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.51 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.62 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.54 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.59 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.71 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.75 ms |
| listVersions (6 versions) | median | 0.17 ms |
| listVersions (6 versions) | p95 | 0.20 ms |
| getUsage (50 files, depth 5) | median | 1.12 ms |
| getUsage (50 files, depth 5) | p95 | 1.51 ms |
| diff (cur vs sibling, 50 files) | median | 0.99 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.44 ms |
| writeFile (new file in existing dir) | median | 6.49 ms |
| writeFile (new file in existing dir) | p95 | 6.98 ms |
| writeFile (overwrite existing) | median | 6.64 ms |
| writeFile (overwrite existing) | p95 | 7.54 ms |

## after-writefile-fuse-v2-3  _(2026-05-07T16:01:50.123Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.40 ms |
| fork after 1000 files | fork() | 5.80 ms |
| fork after 5000 files | fork() | 2.01 ms |
| read at depth 1 | median | 0.52 ms |
| read at depth 1 | p95 | 0.62 ms |
| read at depth 5 | median | 0.49 ms |
| read at depth 5 | p95 | 0.56 ms |
| read at depth 25 | median | 0.49 ms |
| read at depth 25 | p95 | 0.66 ms |
| read at depth 50 | median | 0.50 ms |
| read at depth 50 | p95 | 0.57 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 138.69 MiB -> 138.69 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 7.90 ms |
| readdir(/d) at depth 10, 100 files | median | 1.05 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.30 ms |
| readFileBuffer (text, 200 lines) | median | 0.48 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.59 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.48 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.56 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.47 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.54 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.65 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.72 ms |
| listVersions (6 versions) | median | 0.14 ms |
| listVersions (6 versions) | p95 | 0.21 ms |
| getUsage (50 files, depth 5) | median | 1.08 ms |
| getUsage (50 files, depth 5) | p95 | 1.59 ms |
| diff (cur vs sibling, 50 files) | median | 0.86 ms |
| diff (cur vs sibling, 50 files) | p95 | 0.91 ms |
| writeFile (new file in existing dir) | median | 6.18 ms |
| writeFile (new file in existing dir) | p95 | 6.67 ms |
| writeFile (overwrite existing) | median | 6.24 ms |
| writeFile (overwrite existing) | p95 | 6.82 ms |

## after-writefile-fuse-v2-4  _(2026-05-07T16:02:26.127Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.64 ms |
| fork after 1000 files | fork() | 6.19 ms |
| fork after 5000 files | fork() | 2.11 ms |
| read at depth 1 | median | 0.49 ms |
| read at depth 1 | p95 | 0.53 ms |
| read at depth 5 | median | 0.52 ms |
| read at depth 5 | p95 | 0.69 ms |
| read at depth 25 | median | 0.50 ms |
| read at depth 25 | p95 | 0.69 ms |
| read at depth 50 | median | 0.51 ms |
| read at depth 50 | p95 | 0.62 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 139.68 MiB -> 139.68 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 7.83 ms |
| readdir(/d) at depth 10, 100 files | median | 1.01 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.13 ms |
| readFileBuffer (text, 200 lines) | median | 0.52 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.59 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.50 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.60 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.52 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.67 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.64 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.74 ms |
| listVersions (6 versions) | median | 0.17 ms |
| listVersions (6 versions) | p95 | 0.20 ms |
| getUsage (50 files, depth 5) | median | 1.11 ms |
| getUsage (50 files, depth 5) | p95 | 2.17 ms |
| diff (cur vs sibling, 50 files) | median | 0.86 ms |
| diff (cur vs sibling, 50 files) | p95 | 0.91 ms |
| writeFile (new file in existing dir) | median | 6.22 ms |
| writeFile (new file in existing dir) | p95 | 6.69 ms |
| writeFile (overwrite existing) | median | 6.39 ms |
| writeFile (overwrite existing) | p95 | 7.16 ms |

## after-skip-mkdir-1  _(2026-05-07T16:18:10.767Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 2.34 ms |
| fork after 1000 files | fork() | 2.21 ms |
| fork after 5000 files | fork() | 5.67 ms |
| read at depth 1 | median | 0.79 ms |
| read at depth 1 | p95 | 1.43 ms |
| read at depth 5 | median | 0.53 ms |
| read at depth 5 | p95 | 0.73 ms |
| read at depth 25 | median | 0.63 ms |
| read at depth 25 | p95 | 0.95 ms |
| read at depth 50 | median | 0.98 ms |
| read at depth 50 | p95 | 3.29 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 139.84 MiB -> 139.84 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 9.40 ms |
| readdir(/d) at depth 10, 100 files | median | 1.33 ms |
| readdir(/d) at depth 10, 100 files | p95 | 2.02 ms |
| readFileBuffer (text, 200 lines) | median | 0.78 ms |
| readFileBuffer (text, 200 lines) | p95 | 1.77 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.76 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 1.09 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.76 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 1.38 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.87 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 1.44 ms |
| listVersions (6 versions) | median | 0.25 ms |
| listVersions (6 versions) | p95 | 0.53 ms |
| getUsage (50 files, depth 5) | median | 1.43 ms |
| getUsage (50 files, depth 5) | p95 | 2.60 ms |
| diff (cur vs sibling, 50 files) | median | 1.94 ms |
| diff (cur vs sibling, 50 files) | p95 | 4.75 ms |
| writeFile (new file in existing dir) | median | 6.58 ms |
| writeFile (new file in existing dir) | p95 | 7.21 ms |
| writeFile (overwrite existing) | median | 6.27 ms |
| writeFile (overwrite existing) | p95 | 8.34 ms |

## after-skip-mkdir-2  _(2026-05-07T16:19:03.514Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 2.77 ms |
| fork after 1000 files | fork() | 2.31 ms |
| fork after 5000 files | fork() | 5.64 ms |
| read at depth 1 | median | 0.51 ms |
| read at depth 1 | p95 | 0.69 ms |
| read at depth 5 | median | 0.52 ms |
| read at depth 5 | p95 | 0.74 ms |
| read at depth 25 | median | 0.52 ms |
| read at depth 25 | p95 | 0.98 ms |
| read at depth 50 | median | 0.57 ms |
| read at depth 50 | p95 | 0.72 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 138.31 MiB -> 138.31 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.22 ms |
| readdir(/d) at depth 10, 100 files | median | 1.00 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.03 ms |
| readFileBuffer (text, 200 lines) | median | 0.50 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.64 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.50 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.55 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.50 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.65 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.64 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.69 ms |
| listVersions (6 versions) | median | 0.14 ms |
| listVersions (6 versions) | p95 | 0.21 ms |
| getUsage (50 files, depth 5) | median | 1.16 ms |
| getUsage (50 files, depth 5) | p95 | 1.31 ms |
| diff (cur vs sibling, 50 files) | median | 0.90 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.26 ms |
| writeFile (new file in existing dir) | median | 5.96 ms |
| writeFile (new file in existing dir) | p95 | 6.35 ms |
| writeFile (overwrite existing) | median | 5.87 ms |
| writeFile (overwrite existing) | p95 | 6.49 ms |

## after-skip-mkdir-3  _(2026-05-07T16:19:40.587Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.08 ms |
| fork after 1000 files | fork() | 5.76 ms |
| fork after 5000 files | fork() | 4.27 ms |
| read at depth 1 | median | 0.49 ms |
| read at depth 1 | p95 | 0.55 ms |
| read at depth 5 | median | 0.49 ms |
| read at depth 5 | p95 | 0.52 ms |
| read at depth 25 | median | 0.50 ms |
| read at depth 25 | p95 | 0.55 ms |
| read at depth 50 | median | 0.51 ms |
| read at depth 50 | p95 | 0.59 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 137.82 MiB -> 137.82 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.72 ms |
| readdir(/d) at depth 10, 100 files | median | 0.99 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.40 ms |
| readFileBuffer (text, 200 lines) | median | 0.49 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.70 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.49 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.70 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.49 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.64 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.65 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.69 ms |
| listVersions (6 versions) | median | 0.15 ms |
| listVersions (6 versions) | p95 | 0.24 ms |
| getUsage (50 files, depth 5) | median | 1.13 ms |
| getUsage (50 files, depth 5) | p95 | 1.18 ms |
| diff (cur vs sibling, 50 files) | median | 0.97 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.14 ms |
| writeFile (new file in existing dir) | median | 6.06 ms |
| writeFile (new file in existing dir) | p95 | 6.56 ms |
| writeFile (overwrite existing) | median | 6.28 ms |
| writeFile (overwrite existing) | p95 | 7.09 ms |

## unlabeled  _(2026-05-11T10:54:53.060Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 2.93 ms |
| fork after 1000 files | fork() | 2.10 ms |
| fork after 5000 files | fork() | 4.78 ms |
| read at depth 1 | median | 0.44 ms |
| read at depth 1 | p95 | 0.55 ms |
| read at depth 5 | median | 0.41 ms |
| read at depth 5 | p95 | 0.55 ms |
| read at depth 25 | median | 0.37 ms |
| read at depth 25 | p95 | 0.57 ms |
| read at depth 50 | median | 0.43 ms |
| read at depth 50 | p95 | 0.63 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 33.66 MiB -> 33.66 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 14.72 ms |
| readdir(/d) at depth 10, 100 files | median | 1.13 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.44 ms |
| readFileBuffer (text, 200 lines) | median | 0.44 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.53 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.42 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.60 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.51 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.76 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.63 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.97 ms |
| listVersions (6 versions) | median | 0.21 ms |
| listVersions (6 versions) | p95 | 0.36 ms |
| getUsage (50 files, depth 5) | median | 1.30 ms |
| getUsage (50 files, depth 5) | p95 | 2.23 ms |
| diff (cur vs sibling, 50 files) | median | 1.15 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.55 ms |
| writeFile (new file in existing dir) | median | 6.69 ms |
| writeFile (new file in existing dir) | p95 | 7.10 ms |
| writeFile (overwrite existing) | median | 6.73 ms |
| writeFile (overwrite existing) | p95 | 7.44 ms |

## unlabeled  _(2026-05-11T10:55:25.097Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.52 ms |
| fork after 1000 files | fork() | 2.27 ms |
| fork after 5000 files | fork() | 2.49 ms |
| read at depth 1 | median | 0.62 ms |
| read at depth 1 | p95 | 1.27 ms |
| read at depth 5 | median | 0.42 ms |
| read at depth 5 | p95 | 0.70 ms |
| read at depth 25 | median | 0.41 ms |
| read at depth 25 | p95 | 0.69 ms |
| read at depth 50 | median | 0.45 ms |
| read at depth 50 | p95 | 0.67 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 37.48 MiB -> 37.48 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.95 ms |
| readdir(/d) at depth 10, 100 files | median | 1.13 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.46 ms |
| readFileBuffer (text, 200 lines) | median | 0.44 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.78 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.45 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.71 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.41 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.85 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.60 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.91 ms |
| listVersions (6 versions) | median | 0.19 ms |
| listVersions (6 versions) | p95 | 0.29 ms |
| getUsage (50 files, depth 5) | median | 1.32 ms |
| getUsage (50 files, depth 5) | p95 | 1.81 ms |
| diff (cur vs sibling, 50 files) | median | 0.96 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.43 ms |
| writeFile (new file in existing dir) | median | 6.23 ms |
| writeFile (new file in existing dir) | p95 | 6.69 ms |
| writeFile (overwrite existing) | median | 6.25 ms |
| writeFile (overwrite existing) | p95 | 6.74 ms |

## unlabeled  _(2026-05-11T10:55:58.717Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.59 ms |
| fork after 1000 files | fork() | 2.11 ms |
| fork after 5000 files | fork() | 2.54 ms |
| read at depth 1 | median | 0.42 ms |
| read at depth 1 | p95 | 0.79 ms |
| read at depth 5 | median | 0.44 ms |
| read at depth 5 | p95 | 0.62 ms |
| read at depth 25 | median | 0.39 ms |
| read at depth 25 | p95 | 0.75 ms |
| read at depth 50 | median | 0.42 ms |
| read at depth 50 | p95 | 0.71 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 37.66 MiB -> 37.66 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 4.90 ms |
| readdir(/d) at depth 10, 100 files | median | 1.12 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.57 ms |
| readFileBuffer (text, 200 lines) | median | 0.44 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.67 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.44 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.62 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.46 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.67 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.63 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.92 ms |
| listVersions (6 versions) | median | 0.15 ms |
| listVersions (6 versions) | p95 | 0.30 ms |
| getUsage (50 files, depth 5) | median | 1.14 ms |
| getUsage (50 files, depth 5) | p95 | 1.61 ms |
| diff (cur vs sibling, 50 files) | median | 1.00 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.46 ms |
| writeFile (new file in existing dir) | median | 5.93 ms |
| writeFile (new file in existing dir) | p95 | 6.58 ms |
| writeFile (overwrite existing) | median | 5.96 ms |
| writeFile (overwrite existing) | p95 | 6.45 ms |

## unlabeled  _(2026-05-11T10:56:58.357Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.28 ms |
| fork after 1000 files | fork() | 6.53 ms |
| fork after 5000 files | fork() | 2.47 ms |
| read at depth 1 | median | 0.43 ms |
| read at depth 1 | p95 | 0.86 ms |
| read at depth 5 | median | 0.41 ms |
| read at depth 5 | p95 | 0.80 ms |
| read at depth 25 | median | 0.41 ms |
| read at depth 25 | p95 | 0.64 ms |
| read at depth 50 | median | 0.45 ms |
| read at depth 50 | p95 | 0.63 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 35.92 MiB -> 35.92 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 6.03 ms |
| readdir(/d) at depth 10, 100 files | median | 1.11 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.67 ms |
| readFileBuffer (text, 200 lines) | median | 0.45 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.61 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.40 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.65 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.43 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.69 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.60 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 1.14 ms |
| listVersions (6 versions) | median | 0.22 ms |
| listVersions (6 versions) | p95 | 0.37 ms |
| getUsage (50 files, depth 5) | median | 1.22 ms |
| getUsage (50 files, depth 5) | p95 | 1.56 ms |
| diff (cur vs sibling, 50 files) | median | 1.03 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.44 ms |
| writeFile (new file in existing dir) | median | 6.03 ms |
| writeFile (new file in existing dir) | p95 | 6.58 ms |
| writeFile (overwrite existing) | median | 6.14 ms |
| writeFile (overwrite existing) | p95 | 6.62 ms |

## unlabeled  _(2026-05-11T10:57:40.446Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 7.59 ms |
| fork after 1000 files | fork() | 2.59 ms |
| fork after 5000 files | fork() | 13.45 ms |
| read at depth 1 | median | 0.42 ms |
| read at depth 1 | p95 | 0.61 ms |
| read at depth 5 | median | 0.39 ms |
| read at depth 5 | p95 | 0.63 ms |
| read at depth 25 | median | 0.40 ms |
| read at depth 25 | p95 | 0.76 ms |
| read at depth 50 | median | 0.40 ms |
| read at depth 50 | p95 | 0.76 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 37.63 MiB -> 37.63 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 6.68 ms |
| readdir(/d) at depth 10, 100 files | median | 1.03 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.50 ms |
| readFileBuffer (text, 200 lines) | median | 0.45 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.56 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.45 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.60 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.46 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.61 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.62 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.87 ms |
| listVersions (6 versions) | median | 0.16 ms |
| listVersions (6 versions) | p95 | 0.35 ms |
| getUsage (50 files, depth 5) | median | 1.13 ms |
| getUsage (50 files, depth 5) | p95 | 1.36 ms |
| diff (cur vs sibling, 50 files) | median | 1.00 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.34 ms |
| writeFile (new file in existing dir) | median | 5.76 ms |
| writeFile (new file in existing dir) | p95 | 6.08 ms |
| writeFile (overwrite existing) | median | 5.75 ms |
| writeFile (overwrite existing) | p95 | 6.17 ms |

## unlabeled  _(2026-05-11T10:58:24.153Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.75 ms |
| fork after 1000 files | fork() | 2.21 ms |
| fork after 5000 files | fork() | 3.00 ms |
| read at depth 1 | median | 0.43 ms |
| read at depth 1 | p95 | 0.65 ms |
| read at depth 5 | median | 0.39 ms |
| read at depth 5 | p95 | 0.73 ms |
| read at depth 25 | median | 0.47 ms |
| read at depth 25 | p95 | 0.72 ms |
| read at depth 50 | median | 0.41 ms |
| read at depth 50 | p95 | 0.69 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 37.96 MiB -> 37.96 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 6.11 ms |
| readdir(/d) at depth 10, 100 files | median | 1.11 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.78 ms |
| readFileBuffer (text, 200 lines) | median | 0.44 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.62 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.40 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.72 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.50 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.82 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.68 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.95 ms |
| listVersions (6 versions) | median | 0.19 ms |
| listVersions (6 versions) | p95 | 0.28 ms |
| getUsage (50 files, depth 5) | median | 1.23 ms |
| getUsage (50 files, depth 5) | p95 | 1.61 ms |
| diff (cur vs sibling, 50 files) | median | 1.02 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.42 ms |
| writeFile (new file in existing dir) | median | 6.08 ms |
| writeFile (new file in existing dir) | p95 | 6.54 ms |
| writeFile (overwrite existing) | median | 6.19 ms |
| writeFile (overwrite existing) | p95 | 6.82 ms |

## git-history-paths-mode  _(2026-05-11T12:14:42.369Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.67 ms |
| fork after 1000 files | fork() | 5.87 ms |
| fork after 5000 files | fork() | 2.93 ms |
| read at depth 1 | median | 0.63 ms |
| read at depth 1 | p95 | 1.14 ms |
| read at depth 5 | median | 0.53 ms |
| read at depth 5 | p95 | 0.78 ms |
| read at depth 25 | median | 0.52 ms |
| read at depth 25 | p95 | 0.65 ms |
| read at depth 50 | median | 0.51 ms |
| read at depth 50 | p95 | 0.58 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 337.26 MiB -> 337.26 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.68 ms |
| promoteTo dropPrevious (1000 files, 100 edited) | elapsed | 48.52 ms |
| readdir(/d) at depth 10, 100 files | median | 1.06 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.35 ms |
| readFileBuffer (text, 200 lines) | median | 0.53 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.76 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.55 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.85 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.52 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.73 ms |
| readFileLines (200 lines, 10-line slice) | median | 1.21 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 2.90 ms |
| listVersions (6 versions) | median | 0.23 ms |
| listVersions (6 versions) | p95 | 0.43 ms |
| getUsage (50 files, depth 5) | median | 1.41 ms |
| getUsage (50 files, depth 5) | p95 | 2.24 ms |
| diff (cur vs sibling, 50 files) | median | 1.16 ms |
| diff (cur vs sibling, 50 files) | p95 | 2.60 ms |
| listHistory metadata (20 versions) | median | 0.65 ms |
| listHistory metadata (20 versions) | p95 | 0.87 ms |
| listHistory with changes (20 versions) | median | 0.55 ms |
| listHistory with changes (20 versions) | p95 | 0.61 ms |
| sweepHistory (21 active versions) | elapsed | 118.93 ms |
| writeFile (new file in existing dir) | median | 5.90 ms |
| writeFile (new file in existing dir) | p95 | 6.34 ms |
| writeFile (overwrite existing) | median | 6.04 ms |
| writeFile (overwrite existing) | p95 | 6.46 ms |

## git-history-paths-mode  _(2026-05-11T12:16:02.511Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.28 ms |
| fork after 1000 files | fork() | 6.46 ms |
| fork after 5000 files | fork() | 2.63 ms |
| read at depth 1 | median | 0.56 ms |
| read at depth 1 | p95 | 0.76 ms |
| read at depth 5 | median | 0.56 ms |
| read at depth 5 | p95 | 0.77 ms |
| read at depth 25 | median | 0.57 ms |
| read at depth 25 | p95 | 0.90 ms |
| read at depth 50 | median | 0.56 ms |
| read at depth 50 | p95 | 1.00 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 338.88 MiB -> 338.88 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 9.01 ms |
| promoteTo dropPrevious (1000 files, 100 edited) | elapsed | 49.51 ms |
| readdir(/d) at depth 10, 100 files | median | 1.04 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.36 ms |
| readFileBuffer (text, 200 lines) | median | 0.53 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.69 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.52 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.73 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.53 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.74 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.68 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.89 ms |
| listVersions (6 versions) | median | 0.19 ms |
| listVersions (6 versions) | p95 | 0.24 ms |
| getUsage (50 files, depth 5) | median | 1.15 ms |
| getUsage (50 files, depth 5) | p95 | 1.36 ms |
| diff (cur vs sibling, 50 files) | median | 1.02 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.30 ms |
| listHistory metadata (20 versions) | median | 0.54 ms |
| listHistory metadata (20 versions) | p95 | 0.63 ms |
| listHistory with changes (20 versions) | median | 0.53 ms |
| listHistory with changes (20 versions) | p95 | 0.58 ms |
| sweepHistory (21 active versions) | elapsed | 74.37 ms |
| listHistory metadata first page (100/1001) | elapsed | 2.87 ms |
| listHistory metadata all pages (1001) | elapsed | 15.35 ms |
| listHistory metadata all pages (1001) | pages | 11 |
| listHistory metadata all pages (1001) | entries | 1001 |
| listHistory changes first page (100/1001) | elapsed | 496.09 ms |
| listHistory metadata first page (100/1001) | has nextCursor | true |
| listHistory paths first page (100/1001) | elapsed | 80.82 ms |
| listHistory paths all pages (1001) | elapsed | 827.74 ms |
| listHistory paths all pages (1001) | pages | 11 |
| listHistory paths all pages (1001) | entries | 1001 |
| versionDiff (single hop, head) | median | 4.95 ms |
| versionDiff (single hop, head) | p95 | 5.70 ms |
| versionDiff (root, full visible tree) | elapsed | 0.91 ms |
| writeFile (new file in existing dir) | median | 5.71 ms |
| writeFile (new file in existing dir) | p95 | 6.11 ms |
| writeFile (overwrite existing) | median | 5.73 ms |
| writeFile (overwrite existing) | p95 | 6.26 ms |

## batched-history  _(2026-05-11T12:26:09.406Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.73 ms |
| fork after 1000 files | fork() | 2.28 ms |
| fork after 5000 files | fork() | 17.00 ms |
| read at depth 1 | median | 0.53 ms |
| read at depth 1 | p95 | 0.70 ms |
| read at depth 5 | median | 0.52 ms |
| read at depth 5 | p95 | 0.63 ms |
| read at depth 25 | median | 0.52 ms |
| read at depth 25 | p95 | 0.65 ms |
| read at depth 50 | median | 0.53 ms |
| read at depth 50 | p95 | 0.69 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 485.89 MiB -> 485.89 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 9.16 ms |
| promoteTo dropPrevious (1000 files, 100 edited) | elapsed | 73.91 ms |
| readdir(/d) at depth 10, 100 files | median | 1.06 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.32 ms |
| readFileBuffer (text, 200 lines) | median | 0.52 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.74 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.54 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.66 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.59 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.94 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.70 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.85 ms |
| listVersions (6 versions) | median | 0.16 ms |
| listVersions (6 versions) | p95 | 0.23 ms |
| getUsage (50 files, depth 5) | median | 1.15 ms |
| getUsage (50 files, depth 5) | p95 | 1.44 ms |
| diff (cur vs sibling, 50 files) | median | 1.05 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.46 ms |
| listHistory metadata (20 versions) | median | 0.54 ms |
| listHistory metadata (20 versions) | p95 | 0.64 ms |
| listHistory with changes (20 versions) | median | 0.47 ms |
| listHistory with changes (20 versions) | p95 | 0.60 ms |
| sweepHistory (21 active versions) | elapsed | 75.62 ms |
| listHistory metadata first page (100/1001) | elapsed | 3.16 ms |
| listHistory metadata all pages (1001) | elapsed | 25.37 ms |
| listHistory metadata all pages (1001) | pages | 11 |
| listHistory metadata all pages (1001) | entries | 1001 |
| listHistory changes first page (100/1001) | elapsed | 7.47 ms |
| listHistory metadata first page (100/1001) | has nextCursor | true |
| listHistory paths first page (100/1001) | elapsed | 7.11 ms |
| listHistory paths all pages (1001) | elapsed | 64.87 ms |
| listHistory paths all pages (1001) | pages | 11 |
| listHistory paths all pages (1001) | entries | 1001 |
| versionDiff (single hop, head) | median | 1.30 ms |
| versionDiff (single hop, head) | p95 | 1.57 ms |
| versionDiff (root, full visible tree) | elapsed | 0.51 ms |
| writeFile (new file in existing dir) | median | 6.24 ms |
| writeFile (new file in existing dir) | p95 | 6.82 ms |
| writeFile (overwrite existing) | median | 5.95 ms |
| writeFile (overwrite existing) | p95 | 6.85 ms |

## batched-sweep  _(2026-05-11T12:30:35.492Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 3.62 ms |
| fork after 1000 files | fork() | 2.26 ms |
| fork after 5000 files | fork() | 2.29 ms |
| read at depth 1 | median | 0.55 ms |
| read at depth 1 | p95 | 0.73 ms |
| read at depth 5 | median | 0.57 ms |
| read at depth 5 | p95 | 0.85 ms |
| read at depth 25 | median | 0.52 ms |
| read at depth 25 | p95 | 0.71 ms |
| read at depth 50 | median | 0.56 ms |
| read at depth 50 | p95 | 0.77 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 560.23 MiB -> 560.23 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 10.87 ms |
| promoteTo dropPrevious (1000 files, 100 edited) | elapsed | 51.61 ms |
| readdir(/d) at depth 10, 100 files | median | 1.06 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.44 ms |
| readFileBuffer (text, 200 lines) | median | 0.50 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.68 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.52 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.77 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.52 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.76 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.70 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.91 ms |
| listVersions (6 versions) | median | 0.21 ms |
| listVersions (6 versions) | p95 | 0.43 ms |
| getUsage (50 files, depth 5) | median | 1.10 ms |
| getUsage (50 files, depth 5) | p95 | 1.34 ms |
| diff (cur vs sibling, 50 files) | median | 0.94 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.35 ms |
| listHistory metadata (20 versions) | median | 0.55 ms |
| listHistory metadata (20 versions) | p95 | 0.78 ms |
| listHistory with changes (20 versions) | median | 0.54 ms |
| listHistory with changes (20 versions) | p95 | 0.76 ms |
| sweepHistory (21 active versions) | elapsed | 46.73 ms |
| listHistory metadata first page (100/1001) | elapsed | 2.73 ms |
| listHistory metadata all pages (1001) | elapsed | 17.38 ms |
| listHistory metadata all pages (1001) | pages | 11 |
| listHistory metadata all pages (1001) | entries | 1001 |
| listHistory changes first page (100/1001) | elapsed | 6.91 ms |
| listHistory metadata first page (100/1001) | has nextCursor | true |
| listHistory paths first page (100/1001) | elapsed | 6.44 ms |
| listHistory paths all pages (1001) | elapsed | 60.46 ms |
| listHistory paths all pages (1001) | pages | 11 |
| listHistory paths all pages (1001) | entries | 1001 |
| versionDiff (single hop, head) | median | 0.86 ms |
| versionDiff (single hop, head) | p95 | 1.04 ms |
| versionDiff (root, full visible tree) | elapsed | 0.49 ms |
| writeFile (new file in existing dir) | median | 6.17 ms |
| writeFile (new file in existing dir) | p95 | 7.08 ms |
| writeFile (overwrite existing) | median | 5.97 ms |
| writeFile (overwrite existing) | p95 | 6.36 ms |

## batched-sweep  _(2026-05-11T12:31:44.497Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| fork after 100 files | fork() | 6.96 ms |
| fork after 1000 files | fork() | 6.44 ms |
| fork after 5000 files | fork() | 2.68 ms |
| read at depth 1 | median | 0.54 ms |
| read at depth 1 | p95 | 0.72 ms |
| read at depth 5 | median | 0.52 ms |
| read at depth 5 | p95 | 0.63 ms |
| read at depth 25 | median | 0.54 ms |
| read at depth 25 | p95 | 0.71 ms |
| read at depth 50 | median | 0.53 ms |
| read at depth 50 | p95 | 0.78 ms |
| storage: 1000 files, fork+1 edit | entry/node rows | 1001 -> 1002 |
| storage: 1000 files, fork+1 edit | blob rows | 1000 -> 1001 |
| storage: 1000 files, fork+1 edit | total bytes (whole DB) | 577.09 MiB -> 577.09 MiB (Δ 0 B) |
| deleteVersion (1000 files, 100 edited) | elapsed | 8.59 ms |
| promoteTo dropPrevious (1000 files, 100 edited) | elapsed | 47.54 ms |
| readdir(/d) at depth 10, 100 files | median | 1.20 ms |
| readdir(/d) at depth 10, 100 files | p95 | 1.71 ms |
| readFileBuffer (text, 200 lines) | median | 0.53 ms |
| readFileBuffer (text, 200 lines) | p95 | 0.72 ms |
| readFileBuffer (binary, 8 KiB) | median | 0.57 ms |
| readFileBuffer (binary, 8 KiB) | p95 | 0.85 ms |
| readFileRange (8 KiB, 64 B slice) | median | 0.56 ms |
| readFileRange (8 KiB, 64 B slice) | p95 | 0.80 ms |
| readFileLines (200 lines, 10-line slice) | median | 0.71 ms |
| readFileLines (200 lines, 10-line slice) | p95 | 0.90 ms |
| listVersions (6 versions) | median | 0.21 ms |
| listVersions (6 versions) | p95 | 0.28 ms |
| getUsage (50 files, depth 5) | median | 1.20 ms |
| getUsage (50 files, depth 5) | p95 | 1.62 ms |
| diff (cur vs sibling, 50 files) | median | 1.16 ms |
| diff (cur vs sibling, 50 files) | p95 | 1.79 ms |
| listHistory metadata (20 versions) | median | 0.55 ms |
| listHistory metadata (20 versions) | p95 | 0.66 ms |
| listHistory with changes (20 versions) | median | 0.51 ms |
| listHistory with changes (20 versions) | p95 | 0.97 ms |
| sweepHistory (21 active versions) | elapsed | 62.73 ms |
| listHistory metadata first page (100/1001) | elapsed | 2.44 ms |
| listHistory metadata all pages (1001) | elapsed | 16.78 ms |
| listHistory metadata all pages (1001) | pages | 11 |
| listHistory metadata all pages (1001) | entries | 1001 |
| listHistory changes first page (100/1001) | elapsed | 6.81 ms |
| listHistory metadata first page (100/1001) | has nextCursor | true |
| listHistory paths first page (100/1001) | elapsed | 7.76 ms |
| listHistory paths all pages (1001) | elapsed | 65.62 ms |
| listHistory paths all pages (1001) | pages | 11 |
| listHistory paths all pages (1001) | entries | 1001 |
| versionDiff (single hop, head) | median | 0.89 ms |
| versionDiff (single hop, head) | p95 | 1.21 ms |
| versionDiff (root, full visible tree) | elapsed | 0.53 ms |
| writeFile (new file in existing dir) | median | 5.88 ms |
| writeFile (new file in existing dir) | p95 | 6.29 ms |
| writeFile (overwrite existing) | median | 6.00 ms |
| writeFile (overwrite existing) | p95 | 6.52 ms |
