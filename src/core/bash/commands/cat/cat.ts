import type { Command, BashResult } from "../../types.js";
import { ok, err } from "../../types.js";

const READ_CHUNK_SIZE = 4096;

export const catCommand: Command = {
  name: "cat",
  async execute(args, ctx, pipedInput) {
    if (args.length === 0 && pipedInput) return ok(pipedInput);
    if (args.length === 0) return err("cat: missing operand");

    let stdout = "";
    const errors: string[] = [];

    for (const arg of args) {
      if (arg === "-") {
        stdout += pipedInput;
      } else {
        try {
          stdout += await readFileInChunks(ctx.resolve(arg), ctx);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(msg);
        }
      }
    }

    if (stdout === "" && errors.length > 0) {
      return err(errors[0]);
    }

    const result: BashResult = {
      exitCode: errors.length > 0 ? 1 : 0,
      stdout,
      stderr: errors.length > 0 ? errors.map((e) => e + "\n").join("") : "",
    };
    return result;
  },
};

async function readFileInChunks(path: string, ctx: Parameters<Command["execute"]>[1]): Promise<string> {
  let offset = 0;
  let content = "";

  while (true) {
    const chunk = await ctx.fs.readFile(path, {
      offset,
      limit: READ_CHUNK_SIZE,
    });
    if (chunk === "") {
      return content;
    }

    content += chunk;
    if (chunk.length < READ_CHUNK_SIZE) {
      return content;
    }
    offset += chunk.length;
  }
}
