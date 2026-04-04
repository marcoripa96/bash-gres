import type { Command, BashResult } from "../../types.js";
import { ok, err } from "../../types.js";

export const catCommand: Command = {
  name: "cat",
  async execute(args, ctx, pipedInput) {
    if (args.length === 0 && pipedInput) return ok(pipedInput);
    if (args.length === 0) return err("cat: missing operand");

    const parts: string[] = [];
    const errors: string[] = [];

    for (const arg of args) {
      if (arg === "-") {
        parts.push(pipedInput);
      } else {
        try {
          const content = await ctx.fs.readFile(ctx.resolve(arg));
          parts.push(content);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(msg);
        }
      }
    }

    if (parts.length === 0 && errors.length > 0) {
      return err(errors[0]);
    }

    const result: BashResult = {
      exitCode: errors.length > 0 ? 1 : 0,
      stdout: parts.join(""),
      stderr: errors.length > 0 ? errors.map((e) => e + "\n").join("") : "",
    };
    return result;
  },
};
