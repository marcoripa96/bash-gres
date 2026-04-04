import type { Command, CommandContext } from "../../types.js";
import { ok, err } from "../../types.js";
import { matchGlob } from "../../helpers.js";

export const findCommand: Command = {
  name: "find",
  async execute(args, ctx) {
    const searchPaths: string[] = [];
    let namePattern: string | null = null;
    let typeFilter: "f" | "d" | "l" | null = null;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-name") {
        if (args[i + 1] === undefined) {
          return err("find: missing argument to `-name'");
        }
        namePattern = args[i + 1];
        i++;
        continue;
      }

      if (args[i] === "-type") {
        if (args[i + 1] === undefined) {
          return err("find: missing argument to `-type'");
        }
        const candidate = args[i + 1];
        if (candidate !== "f" && candidate !== "d" && candidate !== "l") {
          return err(`find: Unknown argument to -type: ${candidate}`);
        }
        typeFilter = candidate;
        i++;
        continue;
      }

      if (!args[i].startsWith("-")) {
        searchPaths.push(args[i]);
      }
    }

    const roots = searchPaths.length > 0 ? searchPaths : ["."];
    const found: string[] = [];

    for (const searchPath of roots) {
      const resolved = ctx.resolve(searchPath);
      const useRelative = !searchPath.startsWith("/");
      const displayRoot = useRelative ? normalizeRelativeRoot(searchPath) : resolved;
      const rootInfo = await ctx.fs.lstat(resolved);

      if (matchesEntry(rootDisplayName(displayRoot), rootInfo, namePattern, typeFilter)) {
        found.push(displayRoot);
      }

      if (rootInfo.isDirectory) {
        const descendants = await ctx.fs.walk(resolved);
        for (const entry of descendants) {
          if (!matchesEntry(entry.name, entry, namePattern, typeFilter)) {
            continue;
          }

          if (useRelative) {
            const suffix = entry.path.slice(resolved.length);
            found.push(`${displayRoot}${suffix}`);
          } else {
            found.push(entry.path);
          }
        }
      }
    }

    return ok(found.join("\n") + (found.length ? "\n" : ""));
  },
};

function matchesEntry(
  name: string,
  entry: {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
  },
  namePattern: string | null,
  typeFilter: "f" | "d" | "l" | null,
): boolean {
  const typeMatch =
    typeFilter === null ||
    (typeFilter === "f" && entry.isFile) ||
    (typeFilter === "d" && entry.isDirectory) ||
    (typeFilter === "l" && entry.isSymbolicLink);

  const nameMatch = namePattern === null || matchGlob(name, namePattern);
  return typeMatch && nameMatch;
}

function normalizeRelativeRoot(searchPath: string): string {
  const trimmed = searchPath.replace(/\/+$/, "");
  return trimmed === "" ? "." : trimmed;
}

function rootDisplayName(displayRoot: string): string {
  if (displayRoot === "/") return "/";
  if (displayRoot === "." || displayRoot === "..") return displayRoot;
  const parts = displayRoot.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? displayRoot;
}
