import type { Command, CommandContext } from "../../types.js";
import { ok } from "../../types.js";
import { parentPath } from "../../../path-encoding.js";

interface TreeEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  symlinkTarget: string | null;
}

export const treeCommand: Command = {
  name: "tree",
  async execute(args, ctx) {
    const target = args[0] ? ctx.resolve(args[0]) : ctx.cwd;
    const lines: string[] = [target];
    const rootPath = await ctx.fs.realpath(target).catch(() => target);
    const descendants = await ctx.fs.walk(target);
    const childrenByParent = new Map<string, TreeEntry[]>();

    for (const entry of descendants) {
      const parent = parentPath(entry.path);
      const siblings = childrenByParent.get(parent);
      const treeEntry: TreeEntry = {
        path: entry.path,
        name: entry.name,
        isDirectory: entry.isDirectory,
        isSymbolicLink: entry.isSymbolicLink,
        symlinkTarget: entry.symlinkTarget,
      };
      if (siblings) {
        siblings.push(treeEntry);
      } else {
        childrenByParent.set(parent, [treeEntry]);
      }
    }

    renderTree(rootPath, "", childrenByParent, lines);
    return ok(lines.join("\n") + "\n");
  },
};

function renderTree(
  dir: string,
  prefix: string,
  childrenByParent: Map<string, TreeEntry[]>,
  lines: string[],
): void {
  const entries = childrenByParent.get(dir) ?? [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? "└── " : "├── ";

    let suffix = "";
    if (entry.isDirectory) {
      suffix = "/";
    } else if (entry.isSymbolicLink) {
      suffix = entry.symlinkTarget !== null ? ` -> ${entry.symlinkTarget}` : " -> ?";
    }

    lines.push(`${prefix}${connector}${entry.name}${suffix}`);

    if (entry.isDirectory) {
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      renderTree(entry.path, childPrefix, childrenByParent, lines);
    }
  }
}
