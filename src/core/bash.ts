import type { PgFileSystem } from "./filesystem.js";
import type { BashResult } from "./types.js";

export class BashInterpreter {
  private fs: PgFileSystem;
  private cwd: string = "/";

  constructor(fs: PgFileSystem) {
    this.fs = fs;
  }

  async execute(input: string): Promise<BashResult> {
    const commands = splitPipe(input);
    let lastResult: BashResult = { exitCode: 0, stdout: "", stderr: "" };

    for (const cmd of commands) {
      lastResult = await this.executeOne(cmd.trim(), lastResult.stdout);
      if (lastResult.exitCode !== 0) break;
    }

    return lastResult;
  }

  private resolve(path: string): string {
    return this.fs.resolvePath(this.cwd, path);
  }

  private async executeOne(
    input: string,
    pipedInput: string,
  ): Promise<BashResult> {
    const parsed = parseCommand(input);
    if (!parsed) return ok("");

    const { command, args, redirect } = parsed;

    try {
      let result: BashResult;

      switch (command) {
        case "ls":
          result = await this.cmdLs(args);
          break;
        case "cat":
          result = await this.cmdCat(args, pipedInput);
          break;
        case "echo":
          result = ok(args.join(" ") + "\n");
          break;
        case "mkdir":
          result = await this.cmdMkdir(args);
          break;
        case "rm":
          result = await this.cmdRm(args);
          break;
        case "cp":
          result = await this.cmdCp(args);
          break;
        case "mv":
          result = await this.cmdMv(args);
          break;
        case "touch":
          result = await this.cmdTouch(args);
          break;
        case "pwd":
          result = ok(this.cwd + "\n");
          break;
        case "cd":
          result = await this.cmdCd(args);
          break;
        case "stat":
          result = await this.cmdStat(args);
          break;
        case "chmod":
          result = await this.cmdChmod(args);
          break;
        case "head":
          result = await this.cmdHead(args, pipedInput);
          break;
        case "tail":
          result = await this.cmdTail(args, pipedInput);
          break;
        case "wc":
          result = await this.cmdWc(args, pipedInput);
          break;
        case "find":
          result = await this.cmdFind(args);
          break;
        case "grep":
          result = await this.cmdGrep(args, pipedInput);
          break;
        case "tree":
          result = await this.cmdTree(args);
          break;
        case "ln":
          result = await this.cmdLn(args);
          break;
        case "readlink":
          result = await this.cmdReadlink(args);
          break;
        default:
          return err(`bash: ${command}: command not found`);
      }

      if (redirect && result.exitCode === 0) {
        if (redirect.type === ">") {
          await this.fs.writeFile(
            this.resolve(redirect.target),
            result.stdout,
            { recursive: true },
          );
        } else if (redirect.type === ">>") {
          try {
            await this.fs.appendFile(
              this.resolve(redirect.target),
              result.stdout,
            );
          } catch {
            await this.fs.writeFile(
              this.resolve(redirect.target),
              result.stdout,
              { recursive: true },
            );
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

  // -- Commands ---------------------------------------------------------------

  private async cmdLs(args: string[]): Promise<BashResult> {
    let longFormat = false;
    let showAll = false;
    const paths: string[] = [];

    for (const arg of args) {
      if (arg.startsWith("-")) {
        if (arg.includes("l")) longFormat = true;
        if (arg.includes("a")) showAll = true;
      } else {
        paths.push(arg);
      }
    }

    const target = paths[0] ? this.resolve(paths[0]) : this.cwd;

    const stat = await this.fs.stat(target);
    if (!stat.isDirectory) {
      const name = target.split("/").pop() || target;
      if (longFormat) {
        return ok(formatLong(name, stat) + "\n");
      }
      return ok(name + "\n");
    }

    const entries = await this.fs.readdirWithTypes(target);
    const filtered = showAll
      ? entries
      : entries.filter((e) => !e.name.startsWith("."));

    if (!longFormat) {
      return ok(filtered.map((e) => e.name).join("\n") + (filtered.length ? "\n" : ""));
    }

    const lines: string[] = [];
    for (const entry of filtered) {
      const entryPath =
        target === "/" ? `/${entry.name}` : `${target}/${entry.name}`;
      const s = await this.fs.lstat(entryPath);
      lines.push(formatLong(entry.name, s));
    }
    return ok(lines.join("\n") + (lines.length ? "\n" : ""));
  }

  private async cmdCat(
    args: string[],
    pipedInput: string,
  ): Promise<BashResult> {
    if (args.length === 0 && pipedInput) return ok(pipedInput);
    if (args.length === 0) return err("cat: missing operand");

    const parts: string[] = [];
    for (const arg of args) {
      if (arg === "-") {
        parts.push(pipedInput);
      } else {
        const content = await this.fs.readFile(this.resolve(arg));
        parts.push(content);
      }
    }
    return ok(parts.join(""));
  }

  private async cmdMkdir(args: string[]): Promise<BashResult> {
    let recursive = false;
    const paths: string[] = [];
    for (const arg of args) {
      if (arg === "-p") recursive = true;
      else paths.push(arg);
    }
    if (paths.length === 0) return err("mkdir: missing operand");
    for (const p of paths) {
      await this.fs.mkdir(this.resolve(p), { recursive });
    }
    return ok("");
  }

  private async cmdRm(args: string[]): Promise<BashResult> {
    let recursive = false;
    let force = false;
    const paths: string[] = [];
    for (const arg of args) {
      if (arg.startsWith("-")) {
        if (arg.includes("r") || arg.includes("R")) recursive = true;
        if (arg.includes("f")) force = true;
      } else {
        paths.push(arg);
      }
    }
    if (paths.length === 0) return err("rm: missing operand");
    for (const p of paths) {
      await this.fs.rm(this.resolve(p), { recursive, force });
    }
    return ok("");
  }

  private async cmdCp(args: string[]): Promise<BashResult> {
    let recursive = false;
    const paths: string[] = [];
    for (const arg of args) {
      if (arg === "-r" || arg === "-R") recursive = true;
      else paths.push(arg);
    }
    if (paths.length < 2) return err("cp: missing operand");
    await this.fs.cp(this.resolve(paths[0]), this.resolve(paths[1]), {
      recursive,
    });
    return ok("");
  }

  private async cmdMv(args: string[]): Promise<BashResult> {
    const paths = args.filter((a) => !a.startsWith("-"));
    if (paths.length < 2) return err("mv: missing operand");
    await this.fs.mv(this.resolve(paths[0]), this.resolve(paths[1]));
    return ok("");
  }

  private async cmdTouch(args: string[]): Promise<BashResult> {
    if (args.length === 0) return err("touch: missing operand");
    for (const arg of args) {
      const path = this.resolve(arg);
      const exists = await this.fs.exists(path);
      if (exists) {
        await this.fs.utimes(path, new Date(), new Date());
      } else {
        await this.fs.writeFile(path, "", { recursive: true });
      }
    }
    return ok("");
  }

  private async cmdCd(args: string[]): Promise<BashResult> {
    const target = args[0] || "/";
    const resolved = this.resolve(target);
    const stat = await this.fs.stat(resolved);
    if (!stat.isDirectory) {
      return err(`cd: ${target}: Not a directory`);
    }
    this.cwd = resolved;
    return ok("");
  }

  private async cmdStat(args: string[]): Promise<BashResult> {
    if (args.length === 0) return err("stat: missing operand");
    const path = this.resolve(args[0]);
    const s = await this.fs.stat(path);
    const type = s.isDirectory ? "directory" : s.isSymbolicLink ? "symbolic link" : "regular file";
    const lines = [
      `  File: ${args[0]}`,
      `  Size: ${s.size}\tType: ${type}`,
      `  Mode: ${s.mode.toString(8).padStart(4, "0")}`,
      `Modify: ${s.mtime.toISOString()}`,
    ];
    return ok(lines.join("\n") + "\n");
  }

  private async cmdChmod(args: string[]): Promise<BashResult> {
    if (args.length < 2) return err("chmod: missing operand");
    const mode = parseInt(args[0], 8);
    if (isNaN(mode)) return err(`chmod: invalid mode: '${args[0]}'`);
    await this.fs.chmod(this.resolve(args[1]), mode);
    return ok("");
  }

  private async cmdHead(
    args: string[],
    pipedInput: string,
  ): Promise<BashResult> {
    let n = 10;
    const paths: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-n" && args[i + 1]) {
        n = parseInt(args[i + 1], 10);
        i++;
      } else if (!args[i].startsWith("-")) {
        paths.push(args[i]);
      }
    }

    const text =
      paths.length > 0
        ? await this.fs.readFile(this.resolve(paths[0]))
        : pipedInput;

    const lines = text.split("\n").slice(0, n);
    return ok(lines.join("\n") + (lines.length ? "\n" : ""));
  }

  private async cmdTail(
    args: string[],
    pipedInput: string,
  ): Promise<BashResult> {
    let n = 10;
    const paths: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-n" && args[i + 1]) {
        n = parseInt(args[i + 1], 10);
        i++;
      } else if (!args[i].startsWith("-")) {
        paths.push(args[i]);
      }
    }

    const text =
      paths.length > 0
        ? await this.fs.readFile(this.resolve(paths[0]))
        : pipedInput;

    const allLines = text.split("\n");
    // Remove trailing empty element from trailing newline
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }
    const result = allLines.slice(-n);
    return ok(result.join("\n") + (result.length ? "\n" : ""));
  }

  private async cmdWc(
    args: string[],
    pipedInput: string,
  ): Promise<BashResult> {
    let countLines = false;
    let countWords = false;
    let countChars = false;
    const paths: string[] = [];

    for (const arg of args) {
      if (arg.startsWith("-")) {
        if (arg.includes("l")) countLines = true;
        if (arg.includes("w")) countWords = true;
        if (arg.includes("c")) countChars = true;
      } else {
        paths.push(arg);
      }
    }

    if (!countLines && !countWords && !countChars) {
      countLines = countWords = countChars = true;
    }

    const text =
      paths.length > 0
        ? await this.fs.readFile(this.resolve(paths[0]))
        : pipedInput;

    const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    const words = text.split(/\s+/).filter(Boolean).length;
    const chars = new TextEncoder().encode(text).byteLength;

    const parts: string[] = [];
    if (countLines) parts.push(String(lines));
    if (countWords) parts.push(String(words));
    if (countChars) parts.push(String(chars));

    const name = paths[0] || "";
    return ok(parts.join("\t") + (name ? `\t${name}` : "") + "\n");
  }

  private async cmdFind(args: string[]): Promise<BashResult> {
    let searchPath = ".";
    let namePattern: string | null = null;
    let typeFilter: string | null = null;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-name" && args[i + 1]) {
        namePattern = args[i + 1];
        i++;
      } else if (args[i] === "-type" && args[i + 1]) {
        typeFilter = args[i + 1];
        i++;
      } else if (!args[i].startsWith("-")) {
        searchPath = args[i];
      }
    }

    const resolved = this.resolve(searchPath);
    const found = await this.findRecursive(resolved, namePattern, typeFilter);
    return ok(found.join("\n") + (found.length ? "\n" : ""));
  }

  private async findRecursive(
    dir: string,
    namePattern: string | null,
    typeFilter: string | null,
  ): Promise<string[]> {
    const results: string[] = [];
    const entries = await this.fs.readdirWithTypes(dir);

    for (const entry of entries) {
      const fullPath = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;

      const typeMatch =
        typeFilter === null ||
        (typeFilter === "f" && entry.isFile) ||
        (typeFilter === "d" && entry.isDirectory) ||
        (typeFilter === "l" && entry.isSymbolicLink);

      const nameMatch =
        namePattern === null || matchGlob(entry.name, namePattern);

      if (typeMatch && nameMatch) {
        results.push(fullPath);
      }

      if (entry.isDirectory) {
        results.push(...(await this.findRecursive(fullPath, namePattern, typeFilter)));
      }
    }

    return results;
  }

  private async cmdGrep(
    args: string[],
    pipedInput: string,
  ): Promise<BashResult> {
    let recursive = false;
    let ignoreCase = false;
    let lineNumbers = false;
    const positional: string[] = [];

    for (const arg of args) {
      if (arg.startsWith("-")) {
        if (arg.includes("r") || arg.includes("R")) recursive = true;
        if (arg.includes("i")) ignoreCase = true;
        if (arg.includes("n")) lineNumbers = true;
      } else {
        positional.push(arg);
      }
    }

    if (positional.length === 0) return err("grep: missing pattern");

    const pattern = positional[0];
    const regex = new RegExp(pattern, ignoreCase ? "i" : "");

    if (positional.length === 1 && pipedInput) {
      const lines = pipedInput.split("\n");
      const matches = lines
        .map((line, i) => ({ line, num: i + 1 }))
        .filter(({ line }) => regex.test(line))
        .map(({ line, num }) => (lineNumbers ? `${num}:${line}` : line));
      if (matches.length === 0) return { exitCode: 1, stdout: "", stderr: "" };
      return ok(matches.join("\n") + "\n");
    }

    const filePaths = positional.slice(1);
    const allMatches: string[] = [];

    for (const filePath of filePaths) {
      const resolved = this.resolve(filePath);
      if (recursive) {
        await this.grepRecursive(resolved, regex, lineNumbers, allMatches);
      } else {
        const content = await this.fs.readFile(resolved);
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const prefix =
              filePaths.length > 1 ? `${filePath}:` : "";
            const numPrefix = lineNumbers ? `${i + 1}:` : "";
            allMatches.push(`${prefix}${numPrefix}${lines[i]}`);
          }
        }
      }
    }

    if (allMatches.length === 0)
      return { exitCode: 1, stdout: "", stderr: "" };
    return ok(allMatches.join("\n") + "\n");
  }

  private async grepRecursive(
    path: string,
    regex: RegExp,
    lineNumbers: boolean,
    results: string[],
  ): Promise<void> {
    const info = await this.fs.stat(path);
    if (info.isFile) {
      const content = await this.fs.readFile(path);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const numPrefix = lineNumbers ? `${i + 1}:` : "";
          results.push(`${path}:${numPrefix}${lines[i]}`);
        }
      }
      return;
    }
    const entries = await this.fs.readdirWithTypes(path);
    for (const entry of entries) {
      const fullPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
      if (entry.isDirectory) {
        await this.grepRecursive(fullPath, regex, lineNumbers, results);
      } else if (entry.isFile) {
        const content = await this.fs.readFile(fullPath);
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const numPrefix = lineNumbers ? `${i + 1}:` : "";
            results.push(`${fullPath}:${numPrefix}${lines[i]}`);
          }
        }
      }
    }
  }

  private async cmdTree(args: string[]): Promise<BashResult> {
    const target = args[0] ? this.resolve(args[0]) : this.cwd;
    const lines: string[] = [target];
    await this.treeRecursive(target, "", lines);
    return ok(lines.join("\n") + "\n");
  }

  private async treeRecursive(
    dir: string,
    prefix: string,
    lines: string[],
  ): Promise<void> {
    const entries = await this.fs.readdirWithTypes(dir);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const suffix = entry.isDirectory ? "/" : "";
      lines.push(`${prefix}${connector}${entry.name}${suffix}`);

      if (entry.isDirectory) {
        const childPrefix = prefix + (isLast ? "    " : "│   ");
        const fullPath =
          dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
        await this.treeRecursive(fullPath, childPrefix, lines);
      }
    }
  }

  private async cmdLn(args: string[]): Promise<BashResult> {
    let symbolic = false;
    const paths: string[] = [];
    for (const arg of args) {
      if (arg === "-s") symbolic = true;
      else paths.push(arg);
    }
    if (paths.length < 2) return err("ln: missing operand");
    if (symbolic) {
      await this.fs.symlink(paths[0], this.resolve(paths[1]));
    } else {
      await this.fs.link(this.resolve(paths[0]), this.resolve(paths[1]));
    }
    return ok("");
  }

  private async cmdReadlink(args: string[]): Promise<BashResult> {
    if (args.length === 0) return err("readlink: missing operand");
    const target = await this.fs.readlink(this.resolve(args[0]));
    return ok(target + "\n");
  }
}

// -- Helpers ------------------------------------------------------------------

function ok(stdout: string): BashResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function err(stderr: string): BashResult {
  return { exitCode: 1, stdout: "", stderr: stderr + "\n" };
}

function formatLong(
  name: string,
  s: { isDirectory: boolean; isSymbolicLink: boolean; mode: number; size: number; mtime: Date },
): string {
  const type = s.isDirectory ? "d" : s.isSymbolicLink ? "l" : "-";
  const mode = s.mode.toString(8).padStart(4, "0");
  const size = String(s.size).padStart(8);
  const date = s.mtime.toISOString().slice(0, 10);
  return `${type}${mode} ${size} ${date} ${name}`;
}

function matchGlob(name: string, pattern: string): boolean {
  let regex = "^";
  for (const char of pattern) {
    if (char === "*") regex += ".*";
    else if (char === "?") regex += ".";
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  regex += "$";
  return new RegExp(regex).test(name);
}

interface Redirect {
  type: ">" | ">>";
  target: string;
}

interface ParsedCommand {
  command: string;
  args: string[];
  redirect: Redirect | null;
}

function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let redirect: Redirect | null = null;
  let main = trimmed;

  // Extract redirect (>> must be checked before >)
  const appendMatch = main.match(/\s*>>\s*(\S+)\s*$/);
  if (appendMatch) {
    redirect = { type: ">>", target: appendMatch[1] };
    main = main.slice(0, main.length - appendMatch[0].length);
  } else {
    const writeMatch = main.match(/\s*>\s*(\S+)\s*$/);
    if (writeMatch) {
      redirect = { type: ">", target: writeMatch[1] };
      main = main.slice(0, main.length - writeMatch[0].length);
    }
  }

  const tokens = tokenize(main);
  if (tokens.length === 0) return null;

  return {
    command: tokens[0],
    args: tokens.slice(1),
    redirect,
  };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (const char of input) {
    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (char === "\\" && !inSingle) {
      escape = true;
      continue;
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (char === " " && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function splitPipe(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (const char of input) {
    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (char === "\\" && !inSingle) {
      escape = true;
      current += char;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      current += char;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      current += char;
      continue;
    }
    if (char === "|" && !inSingle && !inDouble) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}
