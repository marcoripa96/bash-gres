/**
 * Transparent interop with just-bash Defense-in-Depth (DiD).
 *
 * just-bash 2.14+ enables DiD by default. DiD patches `process.env`,
 * `setTimeout`, and a few other globals, and rejects any read made from
 * within a running script. `node-postgres` touches both on every query, so
 * without this shim a bash-gres command fired from inside `bash.exec(...)`
 * fails with `security violation: process.env.PGBINARY is blocked during
 * script execution`.
 *
 * DiD exposes a "trusted scope" escape hatch
 * (`DefenseInDepthBox.enterTrustedScope` / `leaveTrustedScope`) scoped to
 * the current execution id. Wrapping our SQL calls in that scope lets pg
 * read the env vars it needs while leaving DiD enforced for the rest of
 * the script. bash-gres loads `just-bash` lazily and only uses it when it
 * is installed — if `just-bash` isn't present, `runTrusted` is a no-op and
 * bash-gres runs exactly as before.
 *
 * Cost: the `import("just-bash")` fires exactly once per process (Node
 * caches module loads regardless). After that, `runTrusted` takes a
 * synchronous fast path: no await, no microtask hop, just a lookup on a
 * cached module reference.
 */

type DefenseInDepthBoxLike = {
  getCurrentExecutionId?: () => string | undefined;
  enterTrustedScope?: (executionId: string) => void;
  leaveTrustedScope?: (executionId: string) => void;
};

type Resolved = DefenseInDepthBoxLike | null;

let cached: Resolved | undefined;
let pending: Promise<Resolved> | null = null;

async function loadBox(): Promise<Resolved> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("just-bash");
    cached =
      (mod?.DefenseInDepthBox as DefenseInDepthBoxLike | undefined) ?? null;
  } catch {
    cached = null;
  }
  pending = null;
  return cached ?? null;
}

function withBox<T>(box: Resolved, fn: () => Promise<T>): Promise<T> {
  const executionId = box?.getCurrentExecutionId?.();
  if (!box || !executionId || !box.enterTrustedScope || !box.leaveTrustedScope) {
    return fn();
  }
  box.enterTrustedScope(executionId);
  return fn().finally(() => box.leaveTrustedScope!(executionId));
}

/**
 * Runs `fn` with the current just-bash execution id marked as a trusted
 * scope for Defense-in-Depth purposes. If just-bash is not installed, if
 * DiD is disabled, or if we are not currently inside `bash.exec(...)`,
 * `fn` is called directly with no wrapping.
 */
export function runTrusted<T>(fn: () => Promise<T>): Promise<T> {
  // Fast path — module already resolved (steady state after the first call).
  if (cached !== undefined) return withBox(cached, fn);
  // Slow path — first call in this process triggers the lazy import.
  const resolve = pending ?? (pending = loadBox());
  return resolve.then((box) => withBox(box, fn));
}
