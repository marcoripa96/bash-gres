import { SqlError } from "../../types.js";

/**
 * Build the displaced-label format used by `renameVersion({ swap: true })`:
 * `<newLabel>-prev-YYYYMMDDHHMMSS-<displacedId>`. The trailing version ID
 * makes the label unique within a workspace even if two swaps land in the
 * same UTC second.
 */
export function generatePrevLabel(newLabel: string, displacedId: number): string {
  const now = new Date();
  const ts =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0") +
    String(now.getUTCHours()).padStart(2, "0") +
    String(now.getUTCMinutes()).padStart(2, "0") +
    String(now.getUTCSeconds()).padStart(2, "0");
  return `${newLabel}-prev-${ts}-${displacedId}`;
}

/**
 * Map a PostgreSQL unique-violation (`23505`) on the version-label index
 * to a clear public error. Other errors pass through unchanged.
 */
export function mapVersionLabelUniqueViolation(
  e: unknown,
  label: string,
): unknown {
  if (
    e instanceof SqlError &&
    e.code === "23505" &&
    (e.constraint === "unique_workspace_version_label" ||
      e.constraint === "unique_workspace_version_root_label" ||
      (e.detail ?? "").includes("workspace_id") ||
      e.message.includes("unique_workspace_version_label") ||
      e.message.includes("unique_workspace_version_root_label"))
  ) {
    return new Error(
      `renameVersion: label '${label}' is already used by another version.`,
    );
  }
  return e;
}
