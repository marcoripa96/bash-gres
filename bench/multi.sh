#!/usr/bin/env bash
# Run the bench N times against a target worktree, capture median+p95 per
# scenario per run, then collapse to median-of-medians and min/max spread.
#
# Usage: bench/multi.sh <runs> <bench-script-path>

set -euo pipefail
runs=${1:-5}
script=${2:-bench/run.ts}
url=${TEST_DATABASE_URL:-postgres://postgres:postgres@localhost:5434/bashgres_test}
iter=${BENCH_ITERATIONS:-200}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for i in $(seq 1 "$runs"); do
  TEST_DATABASE_URL="$url" BENCH_ITERATIONS="$iter" \
    npx tsx "$script" 2>&1 | awk '/^[a-z]/ && NF >= 6' > "$tmp/run-$i.txt"
done

# Aggregate per-scenario (column 1 is scenario name potentially with spaces).
# We exploit fixed widths: scan each output, extract median ms (col 3 from end - 2)
# Easier: rerun with a python aggregator since portable bash is painful.
python3 - "$tmp" "$runs" <<'PY'
import sys, os, statistics, re
tmp, runs = sys.argv[1], int(sys.argv[2])
runs_data = []
for i in range(1, runs + 1):
    with open(os.path.join(tmp, f"run-{i}.txt")) as f:
        rows = []
        for line in f:
            parts = re.split(r"\s{2,}", line.strip())
            if len(parts) < 6:
                continue
            name, n, median, p95, p99, queries = parts[:6]
            try:
                rows.append((name, float(median), float(p95), float(p99), int(queries)))
            except ValueError:
                continue
        runs_data.append(rows)

# Group by scenario name across runs
scenarios = {}
for rows in runs_data:
    for name, median, p95, p99, queries in rows:
        scenarios.setdefault(name, []).append((median, p95, p99, queries))

print(f"{'scenario':<30} {'med-of-med':>10} {'min-med':>10} {'max-med':>10} {'spread%':>10} {'queries':>8}")
print("-" * 80)
for name, runs in scenarios.items():
    medians = [r[0] for r in runs]
    queries = runs[0][3]
    mom = statistics.median(medians)
    lo = min(medians)
    hi = max(medians)
    spread = (hi - lo) / mom * 100 if mom else 0
    print(f"{name:<30} {mom:>10.2f} {lo:>10.2f} {hi:>10.2f} {spread:>9.1f}% {queries:>8}")
PY
