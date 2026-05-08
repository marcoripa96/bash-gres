# diffCount bench results

## before  _(2026-05-08T10:23:37.163Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| 100 files | 20 changes | median | 2.272 ms |
| 100 files | 20 changes | p95 | 3.792 ms |
| 1000 files | 100 changes | median | 8.105 ms |
| 1000 files | 100 changes | p95 | 10.376 ms |
| 5000 files | 50 changes (sparse) | median | 37.137 ms |
| 5000 files | 50 changes (sparse) | p95 | 40.915 ms |
| 1000 files | 500 rm + 20 edits | median | 11.635 ms |
| 1000 files | 500 rm + 20 edits | p95 | 20.627 ms |
| 500 files | 45 mixed (no filter) | median | 5.669 ms |
| 500 files | 45 mixed (no filter) | p95 | 8.767 ms |
| 500 files | 45 mixed (nodeType=file) | median | 5.020 ms |
| 500 files | 45 mixed (nodeType=file) | p95 | 5.466 ms |
| depth 25 | 500 files | 20 edits at tip | median | 11.025 ms |
| depth 25 | 500 files | 20 edits at tip | p95 | 12.507 ms |

## after  _(2026-05-08T10:25:32.459Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| 100 files | 20 changes | median | 1.716 ms |
| 100 files | 20 changes | p95 | 2.122 ms |
| 1000 files | 100 changes | median | 4.182 ms |
| 1000 files | 100 changes | p95 | 4.918 ms |
| 5000 files | 50 changes (sparse) | median | 20.400 ms |
| 5000 files | 50 changes (sparse) | p95 | 25.039 ms |
| 1000 files | 500 rm + 20 edits | median | 4.495 ms |
| 1000 files | 500 rm + 20 edits | p95 | 5.140 ms |
| 500 files | 45 mixed (no filter) | median | 2.351 ms |
| 500 files | 45 mixed (no filter) | p95 | 2.723 ms |
| 500 files | 45 mixed (nodeType=file) | median | 2.328 ms |
| 500 files | 45 mixed (nodeType=file) | p95 | 2.632 ms |
| depth 25 | 500 files | 20 edits at tip | median | 2.430 ms |
| depth 25 | 500 files | 20 edits at tip | p95 | 3.176 ms |

## after-2  _(2026-05-08T10:26:20.437Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| 100 files | 20 changes | median | 1.102 ms |
| 100 files | 20 changes | p95 | 1.362 ms |
| 1000 files | 100 changes | median | 3.448 ms |
| 1000 files | 100 changes | p95 | 4.203 ms |
| 5000 files | 50 changes (sparse) | median | 18.174 ms |
| 5000 files | 50 changes (sparse) | p95 | 19.592 ms |
| 1000 files | 500 rm + 20 edits | median | 4.676 ms |
| 1000 files | 500 rm + 20 edits | p95 | 5.596 ms |
| 500 files | 45 mixed (no filter) | median | 2.030 ms |
| 500 files | 45 mixed (no filter) | p95 | 2.479 ms |
| 500 files | 45 mixed (nodeType=file) | median | 1.998 ms |
| 500 files | 45 mixed (nodeType=file) | p95 | 2.283 ms |
| depth 25 | 500 files | 20 edits at tip | median | 2.055 ms |
| depth 25 | 500 files | 20 edits at tip | p95 | 2.362 ms |

## before-warm  _(2026-05-08T10:27:38.837Z)_

| Scenario | Metric | Value |
| --- | --- | --- |
| 100 files | 20 changes | median | 1.626 ms |
| 100 files | 20 changes | p95 | 2.117 ms |
| 1000 files | 100 changes | median | 4.262 ms |
| 1000 files | 100 changes | p95 | 4.674 ms |
| 5000 files | 50 changes (sparse) | median | 18.758 ms |
| 5000 files | 50 changes (sparse) | p95 | 20.344 ms |
| 1000 files | 500 rm + 20 edits | median | 4.418 ms |
| 1000 files | 500 rm + 20 edits | p95 | 4.778 ms |
| 500 files | 45 mixed (no filter) | median | 2.442 ms |
| 500 files | 45 mixed (no filter) | p95 | 3.410 ms |
| 500 files | 45 mixed (nodeType=file) | median | 2.345 ms |
| 500 files | 45 mixed (nodeType=file) | p95 | 2.774 ms |
| depth 25 | 500 files | 20 edits at tip | median | 2.447 ms |
| depth 25 | 500 files | 20 edits at tip | p95 | 2.727 ms |
