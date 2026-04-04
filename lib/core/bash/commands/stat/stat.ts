import type { Command } from "../../types.js";
import { ok, err } from "../../types.js";

export const statCommand: Command = {
  name: "stat",
  async execute(args, ctx) {
    if (args.length === 0) return err("stat: missing operand");
    const path = ctx.resolve(args[0]);
    const s = await ctx.fs.lstat(path);
    const type = s.isDirectory
      ? "directory"
      : s.isSymbolicLink
        ? "symbolic link"
        : "regular file";
    const fileLabel = s.isSymbolicLink
      ? `  File: ${args[0]} -> ${await ctx.fs.readlink(path)}`
      : `  File: ${args[0]}`;
    const lines = [
      fileLabel,
      `  Size: ${s.size}\tType: ${type}`,
      `  Mode: ${s.mode.toString(8).padStart(4, "0")}`,
      `Modify: ${s.mtime.toISOString()}`,
    ];
    return ok(lines.join("\n") + "\n");
  },
};
