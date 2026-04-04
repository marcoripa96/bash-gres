import type { Command } from "../../types.js";
import { ok, err } from "../../types.js";

export const chmodCommand: Command = {
  name: "chmod",
  async execute(args, ctx) {
    if (args.length < 2) return err("chmod: missing operand");
    const modeStr = args[0];
    const path = ctx.resolve(args[1]);

    // Try octal first
    if (/^[0-7]+$/.test(modeStr)) {
      const mode = parseInt(modeStr, 8);
      await ctx.fs.chmod(path, mode);
      return ok("");
    }

    // Try symbolic mode (e.g. u+x, go-r, a+rw)
    const symMatch = modeStr.match(/^([ugoa]*)([-+=])([rwx]+)$/);
    if (!symMatch) return err(`chmod: invalid mode: '${modeStr}'`);

    const [, who, op, perms] = symMatch;
    const currentStat = await ctx.fs.stat(path);
    let mode = currentStat.mode;

    let permBits = 0;
    if (perms.includes("r")) permBits |= 4;
    if (perms.includes("w")) permBits |= 2;
    if (perms.includes("x")) permBits |= 1;

    const targets = who === "" || who === "a" ? ["u", "g", "o"] : who.split("");

    for (const t of targets) {
      const shift = t === "u" ? 6 : t === "g" ? 3 : 0;
      const shifted = permBits << shift;
      if (op === "+") mode |= shifted;
      else if (op === "-") mode &= ~shifted;
      else if (op === "=") {
        mode &= ~(7 << shift);
        mode |= shifted;
      }
    }

    await ctx.fs.chmod(path, mode);
    return ok("");
  },
};
