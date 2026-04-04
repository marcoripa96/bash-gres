import type { PgFileSystem } from "../filesystem.js";
import type { BashResult } from "../types.js";
import type { Command, CommandContext } from "./types.js";
import { ok, err } from "./types.js";
import { parseCommand, splitPipe, splitOperators } from "./parsing.js";
import { matchGlob } from "./helpers.js";
import { catCommand } from "./commands/cat/cat.js";
import { cdCommand } from "./commands/cd/cd.js";
import { chmodCommand } from "./commands/chmod/chmod.js";
import { cpCommand } from "./commands/cp/cp.js";
import { echoCommand } from "./commands/echo/echo.js";
import { findCommand } from "./commands/find/find.js";
import { grepCommand } from "./commands/grep/grep.js";
import { headCommand } from "./commands/head/head.js";
import { lnCommand } from "./commands/ln/ln.js";
import { lsCommand } from "./commands/ls/ls.js";
import { mkdirCommand } from "./commands/mkdir/mkdir.js";
import { mvCommand } from "./commands/mv/mv.js";
import { pwdCommand } from "./commands/pwd/pwd.js";
import { readlinkCommand } from "./commands/readlink/readlink.js";
import { rmCommand } from "./commands/rm/rm.js";
import { statCommand } from "./commands/stat/stat.js";
import { tailCommand } from "./commands/tail/tail.js";
import { touchCommand } from "./commands/touch/touch.js";
import { treeCommand } from "./commands/tree/tree.js";
import { wcCommand } from "./commands/wc/wc.js";

export { BashInterpreter };
export type { Command, CommandContext } from "./types.js";

const allCommands: Command[] = [
  catCommand,
  cdCommand,
  chmodCommand,
  cpCommand,
  echoCommand,
  findCommand,
  grepCommand,
  headCommand,
  lnCommand,
  lsCommand,
  mkdirCommand,
  mvCommand,
  pwdCommand,
  readlinkCommand,
  rmCommand,
  statCommand,
  tailCommand,
  touchCommand,
  treeCommand,
  wcCommand,
];

class BashInterpreter {
  private fs: PgFileSystem;
  private cwd: string = "/";
  private commandMap: Map<string, Command>;

  constructor(fs: PgFileSystem) {
    this.fs = fs;
    this.commandMap = new Map(allCommands.map((c) => [c.name, c]));
  }

  async execute(input: string): Promise<BashResult> {
    const segments = splitOperators(input);
    let lastExitCode = 0;
    let fullStdout = "";
    let fullStderr = "";

    for (const { op, cmd } of segments) {
      if (!cmd) continue;

      if (op === "&&" && lastExitCode !== 0) continue;
      if (op === "||" && lastExitCode === 0) continue;

      const pipeCommands = splitPipe(cmd);
      let pipeResult: BashResult = { exitCode: 0, stdout: "", stderr: "" };

      for (const pipeCmd of pipeCommands) {
        pipeResult = await this.executeOne(pipeCmd.trim(), pipeResult.stdout);
        if (pipeResult.exitCode !== 0) break;
      }

      fullStdout += pipeResult.stdout;
      fullStderr += pipeResult.stderr;
      lastExitCode = pipeResult.exitCode;
    }

    return { exitCode: lastExitCode, stdout: fullStdout, stderr: fullStderr };
  }

  private resolve(path: string): string {
    return this.fs.resolvePath(this.cwd, path);
  }

  private async expandGlobs(args: string[]): Promise<string[]> {
    const result: string[] = [];
    for (const arg of args) {
      if (/[*?]/.test(arg) && !arg.startsWith("-")) {
        const dir = this.resolve(
          arg.includes("/") ? arg.slice(0, arg.lastIndexOf("/")) || "/" : ".",
        );
        const pattern = arg.includes("/")
          ? arg.slice(arg.lastIndexOf("/") + 1)
          : arg;
        try {
          const entries = await this.fs.readdirWithTypes(dir);
          const matched = entries
            .filter((e) => matchGlob(e.name, pattern))
            .map((e) => (dir === "/" ? `/${e.name}` : `${dir}/${e.name}`));
          if (matched.length > 0) {
            result.push(...matched.sort());
          } else {
            result.push(arg);
          }
        } catch {
          result.push(arg);
        }
      } else {
        result.push(arg);
      }
    }
    return result;
  }

  private async executeOne(
    input: string,
    pipedInput: string,
  ): Promise<BashResult> {
    const parsed = parseCommand(input);
    if (!parsed) return ok("");

    const { command, args: rawArgs, redirect } = parsed;

    try {
      const args = await this.expandGlobs(rawArgs);

      const cmd = this.commandMap.get(command);
      if (!cmd) return err(`bash: ${command}: command not found`);

      const ctx: CommandContext = {
        fs: this.fs,
        cwd: this.cwd,
        resolve: (path) => this.resolve(path),
        setCwd: (newCwd) => {
          this.cwd = newCwd;
        },
      };

      const result = await cmd.execute(args, ctx, pipedInput);

      if (redirect && result.exitCode === 0) {
        const target = this.resolve(redirect.target);
        if (redirect.type === ">") {
          await this.fs.writeFile(target, result.stdout, { recursive: true });
        } else {
          try {
            await this.fs.appendFile(target, result.stdout);
          } catch {
            await this.fs.writeFile(target, result.stdout, { recursive: true });
          }
        }
        return ok("");
      }

      return result;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  }
}
