import type { PromoteResult } from "../../types.js";
import { op } from "./context.js";

/**
 * Promote the current version to a label, materializing it as a self-owning
 * version, swapping any existing holder out of the way, and optionally
 * deleting that previous holder. The whole sequence is one transaction:
 * `detach()` -> `renameVersion(label, { swap: true })` -> optional
 * `deleteVersion(displacedLabel)`.
 *
 * If `dropPrevious` is true and the displaced version still has descendants,
 * the delete fails and the entire promotion rolls back.
 */
export const promoteTo = op(async (
  ctx,
  label: string,
  opts?: { dropPrevious?: boolean },
): Promise<PromoteResult> => {
    if (!label || label.length === 0) {
      throw new Error("promoteTo: label must be a non-empty string");
    }
    const dropPrevious = opts?.dropPrevious ?? false;
    return ctx.transaction(async (tx) => {
      await tx.detach();
      const renamed = await tx.renameVersion(label, { swap: true });
      if (dropPrevious && renamed.displacedLabel) {
        await tx.deleteVersion(renamed.displacedLabel);
      }
      return {
        label: renamed.label,
        displacedLabel: dropPrevious ? undefined : renamed.displacedLabel,
        droppedPrevious: Boolean(dropPrevious && renamed.displacedLabel),
      };
    });
  });
