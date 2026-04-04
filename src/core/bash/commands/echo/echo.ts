import yargsParser from "yargs-parser";
import type { Command } from "../../types.js";
import { ok } from "../../types.js";

export const echoCommand: Command = {
  name: "echo",
  execute(args) {
    const parsed = yargsParser(args, {
      boolean: ["n", "e"],
      configuration: {
        "short-option-groups": true,
        "unknown-options-as-args": true,
      },
    });
    const noNewline = !!parsed.n;
    const interpretEscapes = !!parsed.e;
    let text = parsed._.map(String).join(" ");

    if (interpretEscapes) {
      text = text
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\r/g, "\r")
        .replace(/\\\\/g, "\\");
    }

    return ok(text + (noNewline ? "" : "\n"));
  },
};
