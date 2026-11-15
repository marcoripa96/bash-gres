import type { MergeResolution } from "../../types.js";

/**
 * Check what a `MergeResolver` returned: `null` when it declined
 * (`null`/`undefined`), else the resolution. Anything other than
 * `{ content: string | Uint8Array }` or `{ remove: true }` throws, naming
 * `opName` and `path`. Shared by `merge()` and `writeFileWithBase()` so both
 * refuse the same values.
 */
export function checkResolution(
  resolution: MergeResolution | null | undefined,
  opName: string,
  path: string,
): MergeResolution | null {
  if (resolution === null || resolution === undefined) return null;
  if ("remove" in resolution && resolution.remove === true) {
    return { remove: true };
  }
  if (
    !("content" in resolution) ||
    !(typeof resolution.content === "string" || resolution.content instanceof Uint8Array)
  ) {
    throw new Error(
      `${opName}: resolver for '${path}' must return { content: string | Uint8Array }, { remove: true }, or undefined`,
    );
  }
  return { content: resolution.content };
}
