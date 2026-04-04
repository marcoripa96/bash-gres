import yargsParser from "yargs-parser";
import type { PgFileSystem } from "./filesystem.js";
import type { BashResult } from "./types.js";

export class BashInterpreter {
  private fs: PgFileSystem;
  private cwd: string = "/";

  constructor(fs: PgFileSystem) {
    this.fs = fs;
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
        const dir = this.resolve(arg.includes("/") ? arg.slice(0, arg.lastIndexOf("/")) || "/" : ".");
        const pattern = arg.includes("/") ? arg.slice(arg.lastIndexOf("/") + 1) : arg;
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
      let result: BashResult;

      switch (command) {
        case "ls":
          result = await this.cmdLs(args);
          break;
        case "cat":
          result = await this.cmdCat(args, pipedInput);
          break;
        case "echo":
          result = this.cmdEcho(args);
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

  // -- Commands ---------------------------------------------------------------

  private async cmdLs(args: string[]): Promise<BashResult> {
    const parsed = yargsParser(args, {
      boolean: ["l", "a"],
      configuration: { "short-option-groups": true },
    });
    const longFormat = !!parsed.l;
    const showAll = !!parsed.a;
    const paths = parsed._.map(String);

    const targets = paths.length > 0 ? paths : [this.cwd];

    // When multiple targets are given and some are files, list them individually
    if (targets.length > 1) {
      const allLines: string[] = [];
      for (const t of targets) {
        const resolved = this.resolve(t);
        const s = await this.fs.stat(resolved);
        if (s.isDirectory) {
          allLines.push(...(await this.lsDir(resolved, longFormat, showAll)));
        } else {
          const name = resolved.split("/").pop() || resolved;
          allLines.push(longFormat ? formatLong(name, s) : name);
        }
      }
      return ok(allLines.join("\n") + (allLines.length ? "\n" : ""));
    }

    const target = this.resolve(targets[0]);

    const stat = await this.fs.stat(target);
    if (!stat.isDirectory) {
      const name = target.split("/").pop() || target;
      if (longFormat) {
        return ok(formatLong(name, stat) + "\n");
      }
      return ok(name + "\n");
    }

    const lines = await this.lsDir(target, longFormat, showAll);
    return ok(lines.join("\n") + (lines.length ? "\n" : ""));
  }

  private async lsDir(
    target: string,
    longFormat: boolean,
    showAll: boolean,
  ): Promise<string[]> {
    const entries = await this.fs.readdirWithTypes(target);
    const filtered = showAll
      ? entries
      : entries.filter((e) => !e.name.startsWith("."));

    if (!longFormat) {
      const names: string[] = [];
      if (showAll) names.push(".", "..");
      names.push(...filtered.map((e) => e.name));
      return names;
    }

    const lines: string[] = [];
    if (showAll) {
      const dirStat = await this.fs.stat(target);
      lines.push(formatLong(".", dirStat));
      const parentDir =
        target === "/"
          ? "/"
          : target.split("/").slice(0, -1).join("/") || "/";
      try {
        const parentStat = await this.fs.stat(parentDir);
        lines.push(formatLong("..", parentStat));
      } catch {
        lines.push(formatLong("..", dirStat));
      }
    }

    for (const entry of filtered) {
      const entryPath =
        target === "/" ? `/${entry.name}` : `${target}/${entry.name}`;
      const s = await this.fs.lstat(entryPath);
      lines.push(formatLong(entry.name, s));
    }
    return lines;
  }

  private async cmdCat(
    args: string[],
    pipedInput: string,
  ): Promise<BashResult> {
    if (args.length === 0 && pipedInput) return ok(pipedInput);
    if (args.length === 0) return err("cat: missing operand");

    const parts: string[] = [];
    const errors: string[] = [];

    for (const arg of args) {
      if (arg === "-") {
        parts.push(pipedInput);
      } else {
        try {
          const content = await this.fs.readFile(this.resolve(arg));
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
  }

  private cmdEcho(args: string[]): BashResult {
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
  }

  private async cmdMkdir(args: string[]): Promise<BashResult> {
    const parsed = yargsParser(args, {
      boolean: ["p"],
      configuration: { "short-option-groups": true },
    });
    const recursive = !!parsed.p;
    const paths = parsed._.map(String);

    if (paths.length === 0) return err("mkdir: missing operand");
    for (const p of paths) {
      await this.fs.mkdir(this.resolve(p), { recursive });
    }
    return ok("");
  }

  private async cmdRm(args: string[]): Promise<BashResult> {
    const parsed = yargsParser(args, {
      boolean: ["r", "R", "f"],
      configuration: { "short-option-groups": true },
    });
    const recursive = !!(parsed.r || parsed.R);
    const force = !!parsed.f;
    const paths = parsed._.map(String);

    if (paths.length === 0) return err("rm: missing operand");

    for (const p of paths) {
      const resolved = this.resolve(p);
      if (resolved === "/") {
        return err("rm: it is dangerous to operate recursively on '/'");
      }
      await this.fs.rm(resolved, { recursive, force });
    }
    return ok("");
  }

  private async cmdCp(args: string[]): Promise<BashResult> {
    const parsed = yargsParser(args, {
      boolean: ["r", "R"],
      configuration: { "short-option-groups": true },
    });
    const recursive = !!(parsed.r || parsed.R);
    const paths = parsed._.map(String);

    if (paths.length < 2) return err("cp: missing operand");

    const src = this.resolve(paths[0]);
    let dest = this.resolve(paths[1]);

    // If dest is an existing directory, copy INTO it
    try {
      const destStat = await this.fs.stat(dest);
      if (destStat.isDirectory) {
        const srcName = src.split("/").pop()!;
        dest = dest === "/" ? `/${srcName}` : `${dest}/${srcName}`;
      }
    } catch {
      // dest doesn't exist, that's fine — cp creates it
    }

    await this.fs.cp(src, dest, { recursive });
    return ok("");
  }

  private async cmdMv(args: string[]): Promise<BashResult> {
    const paths = args.filter((a) => !a.startsWith("-"));
    if (paths.length < 2) return err("mv: missing operand");

    const src = this.resolve(paths[0]);
    let dest = this.resolve(paths[1]);

    // If dest is an existing directory, move INTO it
    try {
      const destStat = await this.fs.stat(dest);
      if (destStat.isDirectory) {
        const srcName = src.split("/").pop()!;
        dest = dest === "/" ? `/${srcName}` : `${dest}/${srcName}`;
      }
    } catch {
      // dest doesn't exist — mv will rename src to dest
    }

    await this.fs.mv(src, dest);
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
    const type = s.isDirectory
      ? "directory"
      : s.isSymbolicLink
        ? "symbolic link"
        : "regular file";
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
    const modeStr = args[0];
    const path = this.resolve(args[1]);

    // Try octal first
    if (/^[0-7]+$/.test(modeStr)) {
      const mode = parseInt(modeStr, 8);
      await this.fs.chmod(path, mode);
      return ok("");
    }

    // Try symbolic mode (e.g. u+x, go-r, a+rw)
    const symMatch = modeStr.match(/^([ugoa]*)([-+=])([rwx]+)$/);
    if (!symMatch) return err(`chmod: invalid mode: '${modeStr}'`);

    const [, who, op, perms] = symMatch;
    const currentStat = await this.fs.stat(path);
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

    await this.fs.chmod(path, mode);
    return ok("");
  }

  private async cmdHead(
    args: string[],
    pipedInput: string,
  ): Promise<BashResult> {
    const parsed = yargsParser(args, {
      string: ["n"],
      configuration: { "short-option-groups": true },
    });
    const nStr = parsed.n !== undefined ? String(parsed.n) : "10";
    const n = parseInt(nStr, 10);
    const paths = parsed._.map(String);

    const text =
      paths.length > 0
        ? await this.fs.readFile(this.resolve(paths[0]))
        : pipedInput;

    const allLines = text.split("\n");
    // Remove trailing empty element from trailing newline
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }

    let result: string[];
    if (n < 0) {
      // head -n -N: all lines except the last N
      result = allLines.slice(0, Math.max(0, allLines.length + n));
    } else {
      result = allLines.slice(0, n);
    }
    return ok(result.join("\n") + (result.length ? "\n" : ""));
  }

  private async cmdTail(
    args: string[],
    pipedInput: string,
  ): Promise<BashResult> {
    const parsed = yargsParser(args, {
      string: ["n"],
      configuration: { "short-option-groups": true },
    });
    const nStr = parsed.n !== undefined ? String(parsed.n) : "10";
    const paths = parsed._.map(String);

    const text =
      paths.length > 0
        ? await this.fs.readFile(this.resolve(paths[0]))
        : pipedInput;

    const allLines = text.split("\n");
    // Remove trailing empty element from trailing newline
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }

    let result: string[];
    if (nStr.startsWith("+")) {
      // tail -n +N: starting from line N (1-based)
      const lineNum = parseInt(nStr.slice(1), 10);
      result = allLines.slice(Math.max(0, lineNum - 1));
    } else {
      const n = parseInt(nStr, 10);
      result = allLines.slice(-n);
    }
    return ok(result.join("\n") + (result.length ? "\n" : ""));
  }

  private async cmdWc(
    args: string[],
    pipedInput: string,
  ): Promise<BashResult> {
    const parsed = yargsParser(args, {
      boolean: ["l", "w", "c"],
      configuration: { "short-option-groups": true },
    });
    let countLines = !!parsed.l;
    let countWords = !!parsed.w;
    let countChars = !!parsed.c;
    const paths = parsed._.map(String);

    if (!countLines && !countWords && !countChars) {
      countLines = countWords = countChars = true;
    }

    const formatWcLine = (text: string, name: string): string => {
      const lines =
        text.length === 0
          ? 0
          : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      const words = text.split(/\s+/).filter(Boolean).length;
      const chars = new TextEncoder().encode(text).byteLength;

      const parts: string[] = [];
      if (countLines) parts.push(String(lines));
      if (countWords) parts.push(String(words));
      if (countChars) parts.push(String(chars));
      return parts.join("\t") + (name ? `\t${name}` : "");
    };

    if (paths.length === 0) {
      return ok(formatWcLine(pipedInput, "") + "\n");
    }

    const outputLines: string[] = [];
    for (const p of paths) {
      const text = await this.fs.readFile(this.resolve(p));
      outputLines.push(formatWcLine(text, p));
    }

    if (paths.length > 1) {
      // Add total line
      let totalText = "";
      for (const p of paths) {
        totalText += await this.fs.readFile(this.resolve(p));
      }
      outputLines.push(formatWcLine(totalText, "total"));
    }

    return ok(outputLines.join("\n") + "\n");
  }

  private async cmdFind(args: string[]): Promise<BashResult> {
    // find uses -name and -type which are single-dash long options.
    // Parse manually to avoid yargs-parser splitting them.
    let searchPath = ".";
    let namePattern: string | null = null;
    let typeFilter: string | null = null;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-name" && args[i + 1] !== undefined) {
        namePattern = args[i + 1];
        i++;
      } else if (args[i] === "-type" && args[i + 1] !== undefined) {
        typeFilter = args[i + 1];
        i++;
      } else if (!args[i].startsWith("-")) {
        searchPath = args[i];
      }
    }

    const resolved = this.resolve(searchPath);
    const useRelative = searchPath === "." || searchPath.startsWith("./");

    // Check if root matches type filter
    const rootMatches =
      typeFilter === null || typeFilter === "d"; // root is always a directory

    const found: string[] = [];

    // Include the search root itself if it matches
    if (rootMatches && namePattern === null) {
      found.push(useRelative ? "." : resolved);
    }

    await this.findRecursive(
      resolved,
      namePattern,
      typeFilter,
      resolved,
      useRelative,
      found,
    );
    return ok(found.join("\n") + (found.length ? "\n" : ""));
  }

  private async findRecursive(
    dir: string,
    namePattern: string | null,
    typeFilter: string | null,
    searchRoot: string,
    useRelative: boolean,
    results: string[],
  ): Promise<void> {
    const entries = await this.fs.readdirWithTypes(dir);

    for (const entry of entries) {
      const fullPath =
        dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;

      const typeMatch =
        typeFilter === null ||
        (typeFilter === "f" && entry.isFile) ||
        (typeFilter === "d" && entry.isDirectory) ||
        (typeFilter === "l" && entry.isSymbolicLink);

      const nameMatch =
        namePattern === null || matchGlob(entry.name, namePattern);

      if (typeMatch && nameMatch) {
        if (useRelative) {
          const rel = fullPath.slice(searchRoot.length);
          results.push("." + rel);
        } else {
          results.push(fullPath);
        }
      }

      if (entry.isDirectory) {
        await this.findRecursive(
          fullPath,
          namePattern,
          typeFilter,
          searchRoot,
          useRelative,
          results,
        );
      }
    }
  }

  private async cmdGrep(
    args: string[],
    pipedInput: string,
  ): Promise<BashResult> {
    const parsed = yargsParser(args, {
      boolean: ["r", "R", "i", "n"],
      configuration: {
        "short-option-groups": true,
        "halt-at-non-option": true,
      },
    });
    const recursive = !!(parsed.r || parsed.R);
    const ignoreCase = !!parsed.i;
    const lineNumbers = !!parsed.n;
    const positional = parsed._.map(String);

    if (positional.length === 0) return err("grep: missing pattern");

    const pattern = positional[0];
    const regex = new RegExp(pattern, ignoreCase ? "i" : "");

    if (positional.length === 1 && pipedInput) {
      const lines = pipedInput.split("\n");
      const matches = lines
        .map((line, i) => ({ line, num: i + 1 }))
        .filter(({ line }) => regex.test(line))
        .map(({ line, num }) => (lineNumbers ? `${num}:${line}` : line));
      if (matches.length === 0)
        return { exitCode: 1, stdout: "", stderr: "" };
      return ok(matches.join("\n") + "\n");
    }

    const filePaths = positional.slice(1);
    const allMatches: string[] = [];
    const showPrefix = filePaths.length > 1 || recursive;

    for (const filePath of filePaths) {
      const resolved = this.resolve(filePath);
      if (recursive) {
        await this.grepRecursive(
          resolved,
          regex,
          lineNumbers,
          allMatches,
        );
      } else {
        const content = await this.fs.readFile(resolved);
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const prefix = showPrefix ? `${filePath}:` : "";
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
      const fullPath =
        path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
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
      const fullPath =
        dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;

      let suffix = "";
      if (entry.isDirectory) {
        suffix = "/";
      } else if (entry.isSymbolicLink) {
        try {
          const target = await this.fs.readlink(fullPath);
          suffix = ` -> ${target}`;
        } catch {
          suffix = " -> ?";
        }
      }

      lines.push(`${prefix}${connector}${entry.name}${suffix}`);

      if (entry.isDirectory) {
        const childPrefix = prefix + (isLast ? "    " : "│   ");
        await this.treeRecursive(fullPath, childPrefix, lines);
      }
    }
  }

  private async cmdLn(args: string[]): Promise<BashResult> {
    const parsed = yargsParser(args, {
      boolean: ["s"],
      configuration: { "short-option-groups": true },
    });
    const symbolic = !!parsed.s;
    const paths = parsed._.map(String);

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
  s: {
    isDirectory: boolean;
    isSymbolicLink: boolean;
    mode: number;
    size: number;
    mtime: Date;
  },
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

// -- Parsing ------------------------------------------------------------------

interface Redirect {
  type: ">" | ">>";
  target: string;
}

interface ParsedCommand {
  command: string;
  args: string[];
  redirect: Redirect | null;
}

/**
 * Extracts redirect operators from the raw input string, respecting quotes.
 * Returns the main command string (without redirect) and the redirect info.
 */
function extractRedirect(input: string): {
  main: string;
  redirect: Redirect | null;
} {
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  let lastRedirectPos = -1;
  let isAppend = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escape = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && ch === ">") {
      if (input[i + 1] === ">") {
        lastRedirectPos = i;
        isAppend = true;
        i++; // skip second >
      } else {
        lastRedirectPos = i;
        isAppend = false;
      }
    }
  }

  if (lastRedirectPos === -1) {
    return { main: input, redirect: null };
  }

  const opLen = isAppend ? 2 : 1;
  const targetRaw = input.slice(lastRedirectPos + opLen).trim();
  const main = input.slice(0, lastRedirectPos).trimEnd();

  // Tokenize the target to handle quoted paths
  const targetTokens = tokenize(targetRaw);
  if (targetTokens.length === 0) {
    return { main: input, redirect: null };
  }

  return {
    main,
    redirect: {
      type: isAppend ? ">>" : ">",
      target: targetTokens[0],
    },
  };
}

function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const { main, redirect } = extractRedirect(trimmed);

  const tokens = tokenize(main);
  if (tokens.length === 0) return null;

  return {
    command: tokens[0],
    args: tokens.slice(1),
    redirect,
  };
}

/**
 * Tokenize input into tokens, handling single quotes, double quotes,
 * and backslash escaping. In double quotes, only \", \\, \$, \` are
 * special escapes; other \X sequences are kept literally.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "\\") {
        const next = input[i + 1];
        // In double quotes, only these are special escapes
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          current += next;
          i++;
        } else {
          // Keep the backslash literally
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }

    // Outside quotes
    if (ch === "\\") {
      const next = input[i + 1];
      if (next !== undefined) {
        current += next;
        i++;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      continue;
    }

    if (ch === " " || ch === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
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

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escape = true;
      current += ch;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    // Single | is pipe, but || is a logical operator (handled by splitOperators)
    if (ch === "|" && !inSingle && !inDouble && input[i + 1] !== "|") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

interface OperatorSegment {
  op: string | null;
  cmd: string;
}

function splitOperators(input: string): OperatorSegment[] {
  const result: OperatorSegment[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  let currentOp: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escape = true;
      current += ch;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (ch === ";") {
        result.push({ op: currentOp, cmd: current.trim() });
        current = "";
        currentOp = ";";
        continue;
      }
      if (ch === "&" && input[i + 1] === "&") {
        result.push({ op: currentOp, cmd: current.trim() });
        current = "";
        currentOp = "&&";
        i++;
        continue;
      }
      if (ch === "|" && input[i + 1] === "|") {
        result.push({ op: currentOp, cmd: current.trim() });
        current = "";
        currentOp = "||";
        i++;
        continue;
      }
    }

    current += ch;
  }

  if (current.trim()) {
    result.push({ op: currentOp, cmd: current.trim() });
  }

  return result;
}
