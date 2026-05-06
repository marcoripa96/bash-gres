# bash-gres adapter benchmark results

## adapter perf  _(2026-05-06T21:32:20.394Z)_

### Total elapsed

| Scenario | postgres.js | node-postgres | drizzle | prisma |
| --- | --- | --- | --- | --- |
| writeFile x200 (small text) | 1049.4 ms | 790.4 ms | 962.4 ms | 1181.2 ms |
| readFile x200 | 211.9 ms | 161.8 ms | 206.0 ms | 398.7 ms |
| readdir(200 entries) x50 | 176.9 ms | 152.2 ms | 155.5 ms | 220.5 ms |
| writeFile x50 (64 KiB binary) | 285.1 ms | 214.6 ms | 299.7 ms | 448.3 ms |
| stat x200 | 146.3 ms | 109.0 ms | 152.2 ms | 295.4 ms |
| cp -r (200 files) | 521.7 ms | 447.8 ms | 604.2 ms | 611.7 ms |
| fork (200 files) | 3.66 ms | 2.58 ms | 3.54 ms | 5.47 ms |

### Per-call latency (median / p95)

| Scenario | postgres.js | node-postgres | drizzle | prisma |
| --- | --- | --- | --- | --- |
| readFile x200 | 1.03 ms / 1.44 ms | 0.756 ms / 1.21 ms | 0.972 ms / 1.38 ms | 1.89 ms / 2.53 ms |
| readdir(200 entries) x50 | 3.32 ms / 5.01 ms | 2.86 ms / 4.10 ms | 3.04 ms / 3.69 ms | 4.34 ms / 4.97 ms |
| stat x200 | 0.678 ms / 0.997 ms | 0.485 ms / 0.663 ms | 0.687 ms / 1.01 ms | 1.43 ms / 1.91 ms |

## adapter perf  _(2026-05-06T21:33:00.093Z)_

### Total elapsed

| Scenario | postgres.js | node-postgres | drizzle | prisma |
| --- | --- | --- | --- | --- |
| writeFile x200 (small text) | 1003.1 ms | 807.5 ms | 980.6 ms | 1156.2 ms |
| readFile x200 | 193.7 ms | 174.1 ms | 214.7 ms | 403.1 ms |
| readdir(200 entries) x50 | 170.5 ms | 156.1 ms | 154.3 ms | 219.6 ms |
| writeFile x50 (64 KiB binary) | 289.1 ms | 231.5 ms | 298.2 ms | 447.3 ms |
| stat x200 | 133.1 ms | 129.1 ms | 170.3 ms | 304.1 ms |
| cp -r (200 files) | 547.9 ms | 455.8 ms | 569.5 ms | 647.6 ms |
| fork (200 files) | 3.79 ms | 2.21 ms | 2.91 ms | 5.21 ms |

### Per-call latency (median / p95)

| Scenario | postgres.js | node-postgres | drizzle | prisma |
| --- | --- | --- | --- | --- |
| readFile x200 | 0.934 ms / 1.20 ms | 0.816 ms / 1.22 ms | 0.986 ms / 1.59 ms | 1.94 ms / 2.53 ms |
| readdir(200 entries) x50 | 3.19 ms / 4.89 ms | 3.06 ms / 3.99 ms | 3.00 ms / 3.41 ms | 4.18 ms / 5.58 ms |
| stat x200 | 0.629 ms / 0.856 ms | 0.534 ms / 0.961 ms | 0.714 ms / 1.39 ms | 1.46 ms / 1.96 ms |
