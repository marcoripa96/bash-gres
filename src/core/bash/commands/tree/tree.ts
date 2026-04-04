import type { Command, CommandContext } from "../../types.js";
import { ok } from "../../types.js";

export const treeCommand: Command = {
  name: "tree",
  async execute(args, ctx) {
    const target = args[0] ? ctx.resolve(args[0]) : ctx.cwd;
    const lines: string[] = [target];
    await treeRecursive(ctx, target, "", lines);
    return ok(lines.join("\n") + "\n");
  },
};

async function treeRecursive(
  ctx: CommandContext,
  dir: string,
  prefix: string,
  lines: string[],
): Promise<void> {
  const entries = await ctx.fs.readdirWithTypes(dir);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const fullPath =
      dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;

    let suffix = "";
    if (entry.isDirectory) {
      suffix = "/";
    } else if (entry.isSymbolicLink) {
      try {
        const target = await ctx.fs.readlink(fullPath);
        suffix = ` -> ${target}`;
      } catch {
        suffix = " -> ?";
      }
    }

    lines.push(`${prefix}${connector}${entry.name}${suffix}`);

    if (entry.isDirectory) {
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      await treeRecursive(ctx, fullPath, childPrefix, lines);
    }
  }
}
