import type { PgFileSystem } from "../filesystem.js";
import type { BashResult } from "../types.js";

export type { BashResult };

export interface CommandContext {
  fs: PgFileSystem;
  cwd: string;
  resolve(path: string): string;
  setCwd(newCwd: string): void;
}

export interface Command {
  name: string;
  execute(
    args: string[],
    ctx: CommandContext,
    pipedInput: string,
  ): Promise<BashResult> | BashResult;
}

export function ok(stdout: string): BashResult {
  return { exitCode: 0, stdout, stderr: "" };
}

export function err(stderr: string): BashResult {
  return { exitCode: 1, stdout: "", stderr: stderr + "\n" };
}
