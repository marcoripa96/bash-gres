import type { Command } from "../../types.js";
import { ok } from "../../types.js";

export const pwdCommand: Command = {
  name: "pwd",
  execute(_args, ctx) {
    return ok(ctx.cwd + "\n");
  },
};
