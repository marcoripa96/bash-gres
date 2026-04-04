import type { Command, CommandContext } from "../../types.js";
import { ok } from "../../types.js";
import { matchGlob } from "../../helpers.js";

export const findCommand: Command = {
  name: "find",
  async execute(args, ctx) {
    // find uses -name and -type which are single-dash long options.
    // Parse manually to avoid yargs-parser splitting them.
    let searchPath = ".";
    let namePattern: string | null = null;
    let typeFilter: string | null = null;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-name" && args[i + 1] !== undefined) {
        namePattern = args[i + 1];
        i++;
      } else if (args[i] === "-type" && args[i + 1] !== undefined) {
        typeFilter = args[i + 1];
        i++;
      } else if (!args[i].startsWith("-")) {
        searchPath = args[i];
      }
    }

    const resolved = ctx.resolve(searchPath);
    const useRelative = searchPath === "." || searchPath.startsWith("./");

    // Check if root matches type filter
    const rootMatches =
      typeFilter === null || typeFilter === "d"; // root is always a directory

    const found: string[] = [];

    // Include the search root itself if it matches
    if (rootMatches && namePattern === null) {
      found.push(useRelative ? "." : resolved);
    }

    await findRecursive(ctx, resolved, namePattern, typeFilter, resolved, useRelative, found);
    return ok(found.join("\n") + (found.length ? "\n" : ""));
  },
};

async function findRecursive(
  ctx: CommandContext,
  dir: string,
  namePattern: string | null,
  typeFilter: string | null,
  searchRoot: string,
  useRelative: boolean,
  results: string[],
): Promise<void> {
  const entries = await ctx.fs.readdirWithTypes(dir);

  for (const entry of entries) {
    const fullPath =
      dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;

    const typeMatch =
      typeFilter === null ||
      (typeFilter === "f" && entry.isFile) ||
      (typeFilter === "d" && entry.isDirectory) ||
      (typeFilter === "l" && entry.isSymbolicLink);

    const nameMatch =
      namePattern === null || matchGlob(entry.name, namePattern);

    if (typeMatch && nameMatch) {
      if (useRelative) {
        const rel = fullPath.slice(searchRoot.length);
        results.push("." + rel);
      } else {
        results.push(fullPath);
      }
    }

    if (entry.isDirectory) {
      await findRecursive(ctx, fullPath, namePattern, typeFilter, searchRoot, useRelative, results);
    }
  }
}
