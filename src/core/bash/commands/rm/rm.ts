import yargsParser from "yargs-parser";
import type { Command } from "../../types.js";
import { ok, err } from "../../types.js";

export const rmCommand: Command = {
  name: "rm",
  async execute(args, ctx) {
    const parsed = yargsParser(args, {
      boolean: ["r", "R", "f"],
      configuration: { "short-option-groups": true },
    });
    const recursive = !!(parsed.r || parsed.R);
    const force = !!parsed.f;
    const paths = parsed._.map(String);

    if (paths.length === 0) return err("rm: missing operand");

    for (const p of paths) {
      const resolved = ctx.resolve(p);
      if (resolved === "/") {
        return err("rm: it is dangerous to operate recursively on '/'");
      }
      await ctx.fs.rm(resolved, { recursive, force });
    }
    return ok("");
  },
};
