/**
 * jq optimized for bash-gres.
 *
 * For inputs that live on a `PgFileSystem`, this command pushes the JSON
 * parse + filter down to Postgres via SQL/JSON path (`jsonb_path_query`),
 * so only the projected result crosses the wire. Filters outside the
 * pushdownable subset, or inputs from stdin / a non-PgFileSystem fs, fall
 * through to an in-Node evaluator that mirrors native jq semantics.
 */

import type { Command, CommandContext, ExecResult } from "just-bash";
import { PgFileSystem } from "../../../core/filesystem.js";
import { FsError } from "../../../core/types.js";
import { parseFilter, JqParseError } from "./parser.js";
import {
  evaluate,
  JqRuntimeError,
  type JsonValue,
} from "./evaluator.js";
import { formatValue, type FormatOptions } from "./format.js";
import {
  planAggregate,
  planLimitedIter,
  planMapObject,
  planPushdown,
  planSlice,
} from "./pushdown.js";

interface ParsedArgs {
  filter: string;
  files: string[];
  raw: boolean;
  compact: boolean;
  exitStatus: boolean;
  slurp: boolean;
  nullInput: boolean;
  joinOutput: boolean;
  sortKeys: boolean;
  useTab: boolean;
  vars: Map<string, JsonValue>;
}

function parseArgs(args: string[]): ParsedArgs | { error: string; code: number } {
  const out: ParsedArgs = {
    filter: ".",
    files: [],
    raw: false,
    compact: false,
    exitStatus: false,
    slurp: false,
    nullInput: false,
    joinOutput: false,
    sortKeys: false,
    useTab: false,
    vars: new Map(),
  };
  let filterSet = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--arg" || a === "--argjson") {
      const name = args[++i];
      const value = args[++i];
      if (name === undefined || value === undefined) {
        return { error: `jq: ${a} requires a name and value\n`, code: 2 };
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return { error: `jq: invalid variable name: ${name}\n`, code: 2 };
      }
      if (a === "--arg") {
        out.vars.set(name, value);
      } else {
        try {
          out.vars.set(name, JSON.parse(value) as JsonValue);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { error: `jq: invalid JSON text passed to --argjson: ${msg}\n`, code: 2 };
        }
      }
    } else if (a === "-r" || a === "--raw-output") out.raw = true;
    else if (a === "-c" || a === "--compact-output") out.compact = true;
    else if (a === "-e" || a === "--exit-status") out.exitStatus = true;
    else if (a === "-s" || a === "--slurp") out.slurp = true;
    else if (a === "-n" || a === "--null-input") out.nullInput = true;
    else if (a === "-j" || a === "--join-output") out.joinOutput = true;
    else if (a === "-a" || a === "--ascii") {
      /* ignored */
    } else if (a === "-S" || a === "--sort-keys") out.sortKeys = true;
    else if (a === "-C" || a === "--color" || a === "-M" || a === "--monochrome") {
      /* ignored */
    } else if (a === "--tab") out.useTab = true;
    else if (a === "-") out.files.push("-");
    else if (a.startsWith("--")) {
      return { error: `jq: Unknown option: ${a}\n`, code: 2 };
    } else if (a.startsWith("-") && a.length > 1) {
      for (const c of a.slice(1)) {
        if (c === "r") out.raw = true;
        else if (c === "c") out.compact = true;
        else if (c === "e") out.exitStatus = true;
        else if (c === "s") out.slurp = true;
        else if (c === "n") out.nullInput = true;
        else if (c === "j") out.joinOutput = true;
        else if (c === "a") {
          /* ignored */
        } else if (c === "S") out.sortKeys = true;
        else if (c === "C" || c === "M") {
          /* ignored */
        } else return { error: `jq: Unknown option: -${c}\n`, code: 2 };
      }
    } else if (!filterSet) {
      out.filter = a;
      filterSet = true;
    } else {
      out.files.push(a);
    }
  }
  return out;
}

function parseJsonStream(input: string): JsonValue[] {
  const results: JsonValue[] = [];
  let pos = 0;
  const len = input.length;
  while (pos < len) {
    while (pos < len && /\s/.test(input[pos])) pos++;
    if (pos >= len) break;
    const startPos = pos;
    const c = input[pos];
    if (c === "{" || c === "[") {
      const open = c;
      const close = c === "{" ? "}" : "]";
      let depth = 1;
      let inStr = false;
      let esc = false;
      pos++;
      while (pos < len && depth > 0) {
        const ch = input[pos];
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = !inStr;
        else if (!inStr) {
          if (ch === open) depth++;
          else if (ch === close) depth--;
        }
        pos++;
      }
      if (depth !== 0) {
        throw new SyntaxError(
          `Unexpected end of JSON input (unclosed ${open})`,
        );
      }
      results.push(JSON.parse(input.slice(startPos, pos)) as JsonValue);
    } else if (c === '"') {
      let esc = false;
      pos++;
      while (pos < len) {
        const ch = input[pos];
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') {
          pos++;
          break;
        }
        pos++;
      }
      results.push(JSON.parse(input.slice(startPos, pos)) as JsonValue);
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      while (pos < len && /[\d.eE+-]/.test(input[pos])) pos++;
      results.push(JSON.parse(input.slice(startPos, pos)) as JsonValue);
    } else if (input.slice(pos, pos + 4) === "true") {
      results.push(true);
      pos += 4;
    } else if (input.slice(pos, pos + 5) === "false") {
      results.push(false);
      pos += 5;
    } else if (input.slice(pos, pos + 4) === "null") {
      results.push(null);
      pos += 4;
    } else {
      throw new SyntaxError(
        `Invalid JSON at position ${startPos}: unexpected '${input.slice(pos, pos + 8)}'`,
      );
    }
  }
  return results;
}

interface FileInput {
  source: string;
  path?: string;
  content: string;
}

async function readInputs(
  ctx: CommandContext,
  files: string[],
  nullInput: boolean,
): Promise<FileInput[] | { error: string; code: number }> {
  if (nullInput) return [];
  if (files.length === 0 || (files.length === 1 && files[0] === "-")) {
    return [{ source: "stdin", content: ctx.stdin }];
  }
  const out: FileInput[] = [];
  for (const f of files) {
    if (f === "-") {
      out.push({ source: "stdin", content: ctx.stdin });
      continue;
    }
    try {
      const content = await ctx.fs.readFile(f, "utf8");
      out.push({ source: f, path: f, content: String(content) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        error: `jq: error: Could not open file ${f}: ${msg}\n`,
        code: 2,
      };
    }
  }
  return out;
}

function canPushDown(parsed: ParsedArgs): boolean {
  return !parsed.slurp && !parsed.nullInput && parsed.files.length === 1 && parsed.files[0] !== "-";
}

function emitOutput(
  values: JsonValue[],
  opts: FormatOptions,
  joinOutput: boolean,
): string {
  if (values.length === 0) return "";
  const formatted = values.map((v) => formatValue(v, opts));
  const sep = joinOutput ? "" : "\n";
  const body = formatted.join(sep);
  return joinOutput ? body : `${body}\n`;
}

function exitFromValues(values: JsonValue[], exitStatus: boolean): number {
  if (!exitStatus) return 0;
  if (values.length === 0) return 1;
  return values.every((v) => v === null || v === false) ? 1 : 0;
}

export const jqCommand: Command = {
  name: "jq",
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    const parsed = parseArgs(args);
    if ("error" in parsed) {
      return { stdout: "", stderr: parsed.error, exitCode: parsed.code };
    }

    let ast;
    try {
      ast = parseFilter(parsed.filter);
    } catch (e) {
      const msg = e instanceof JqParseError ? e.message : String(e);
      return {
        stdout: "",
        stderr: `jq: parse error: ${msg}\n`,
        exitCode: 3,
      };
    }

    const formatOpts: FormatOptions = {
      compact: parsed.compact,
      raw: parsed.raw,
      sortKeys: parsed.sortKeys,
      useTab: parsed.useTab,
    };

    // -- Postgres pushdown ---------------------------------------------------
    // Three layers, in order of preference:
    //   1. Full pushdown — the entire filter translates to jsonpath and the
    //      type-check (if any) succeeds. Run SQL, format, return.
    //   2. Partial pushdown — a non-trivial path prefix translates; the
    //      remaining `rest` is evaluated in Node against each pushdown
    //      result, avoiding a full-file fetch.
    //   3. Full Node fallback — read the file via fs.readFile and run the
    //      whole filter through the in-Node evaluator.
    if (canPushDown(parsed) && ctx.fs instanceof PgFileSystem) {
      // 0aa. limit(N; <pure-path>[]) → SQL slice, emit elements as a stream.
      const limitPlan = planLimitedIter(ast);
      if (limitPlan !== null) {
        try {
          const r = await ctx.fs.queryJsonSlice(
            parsed.files[0],
            limitPlan.over,
            0,
            limitPlan.limit,
          );
          if (r !== null && Array.isArray(r.value)) {
            const values = r.value as JsonValue[];
            const stdout = emitOutput(values, formatOpts, parsed.joinOutput);
            return {
              stdout,
              stderr: "",
              exitCode: exitFromValues(values, parsed.exitStatus),
            };
          }
        } catch (e) {
          if (isFsError(e)) {
            return {
              stdout: "",
              stderr: `jq: error: Could not open file ${parsed.files[0]}: ${e.message}\n`,
              exitCode: 2,
            };
          }
        }
      }

      // 0z. map({k: <path>, ...}) over array → jsonb_build_object per
      //     element + jsonb_agg. Single SQL round-trip.
      const mapObjPlan = planMapObject(ast);
      if (mapObjPlan !== null) {
        try {
          const r = await ctx.fs.queryJsonMapObject(
            parsed.files[0],
            mapObjPlan.over,
            mapObjPlan.pairs,
          );
          if (r !== null) {
            const values: JsonValue[] = [r.value as JsonValue];
            const stdout = emitOutput(values, formatOpts, parsed.joinOutput);
            return {
              stdout,
              stderr: "",
              exitCode: exitFromValues(values, parsed.exitStatus),
            };
          }
        } catch (e) {
          if (isFsError(e)) {
            return {
              stdout: "",
              stderr: `jq: error: Could not open file ${parsed.files[0]}: ${e.message}\n`,
              exitCode: 2,
            };
          }
        }
      }

      // 0a. Slice pushdown — `<path>[start:end]` returns the slice as
      //     a single JSON array computed by Postgres.
      const slicePlan = planSlice(ast);
      if (slicePlan !== null) {
        try {
          const r = await ctx.fs.queryJsonSlice(
            parsed.files[0],
            slicePlan.over,
            slicePlan.start,
            slicePlan.end,
          );
          if (r !== null) {
            const values: JsonValue[] = [r.value as JsonValue];
            const stdout = emitOutput(values, formatOpts, parsed.joinOutput);
            return {
              stdout,
              stderr: "",
              exitCode: exitFromValues(values, parsed.exitStatus),
            };
          }
        } catch (e) {
          if (isFsError(e)) {
            return {
              stdout: "",
              stderr: `jq: error: Could not open file ${parsed.files[0]}: ${e.message}\n`,
              exitCode: 2,
            };
          }
        }
      }

      // 0. Aggregation pushdown — `<path> | length|add|min|max` collapses
      //    to a single scalar computed in Postgres, never pulling the
      //    array back to Node.
      const aggPlan = planAggregate(ast);
      if (aggPlan !== null) {
        try {
          const aggOptions: {
            keyPath?: string[];
            stringArg?: string;
            replacementArg?: string;
            numericArg?: number;
          } = {};
          if (aggPlan.keyPath !== undefined) aggOptions.keyPath = aggPlan.keyPath;
          if (aggPlan.stringArg !== undefined) aggOptions.stringArg = aggPlan.stringArg;
          if (aggPlan.replacementArg !== undefined) {
            aggOptions.replacementArg = aggPlan.replacementArg;
          }
          if (aggPlan.depth !== undefined) aggOptions.numericArg = aggPlan.depth;
          const r = await ctx.fs.queryJsonAggregate(
            parsed.files[0],
            aggPlan.over,
            aggPlan.kind,
            Object.keys(aggOptions).length > 0 ? aggOptions : undefined,
          );
          if (r !== null) {
            const values: JsonValue[] = [r.value as JsonValue];
            const stdout = emitOutput(values, formatOpts, parsed.joinOutput);
            return {
              stdout,
              stderr: "",
              exitCode: exitFromValues(values, parsed.exitStatus),
            };
          }
          // Type mismatch — fall through to other pushdown / Node paths.
        } catch (e) {
          if (isFsError(e)) {
            return {
              stdout: "",
              stderr: `jq: error: Could not open file ${parsed.files[0]}: ${e.message}\n`,
              exitCode: 2,
            };
          }
        }
      }

      const plan = planPushdown(ast);
      if (plan !== null) {
        try {
          const raw = await ctx.fs.queryJsonPath(parsed.files[0], plan.path, {
            arrayCheckPath: plan.arrayCheckPath,
          });
          if (raw !== null) {
            let pushed: JsonValue[];
            if (plan.wrapResult) {
              // `map(...)` collects iteration into a single array value.
              pushed = [raw as JsonValue];
            } else if (plan.pathSingle && raw.length === 0) {
              pushed = [null];
            } else {
              pushed = raw as JsonValue[];
            }
            if (plan.rest !== null) {
              try {
                const out: JsonValue[] = [];
                for (const v of pushed) {
                  out.push(...evaluate(v, plan.rest, parsed.vars));
                }
                pushed = out;
              } catch (e) {
                if (e instanceof JqRuntimeError) {
                  return {
                    stdout: "",
                    stderr: `jq: error (at <stdin>): ${e.message}\n`,
                    exitCode: 5,
                  };
                }
                throw e;
              }
            }
            const stdout = emitOutput(pushed, formatOpts, parsed.joinOutput);
            return {
              stdout,
              stderr: "",
              exitCode: exitFromValues(pushed, parsed.exitStatus),
            };
          }
          // raw === null: parent value isn't an array — fall through to Node.
        } catch (e) {
          if (isFsError(e)) {
            return {
              stdout: "",
              stderr: `jq: error: Could not open file ${parsed.files[0]}: ${e.message}\n`,
              exitCode: 2,
            };
          }
          // Other Postgres errors (bad jsonpath, malformed JSON in file,
          // etc.) — fall through so the in-Node evaluator surfaces a
          // user-visible jq-style error instead of a SQL message.
        }
      }
    }

    // -- In-Node fallback ----------------------------------------------------
    const inputs = await readInputs(ctx, parsed.files, parsed.nullInput);
    if (!Array.isArray(inputs)) {
      return { stdout: "", stderr: inputs.error, exitCode: inputs.code };
    }

    let values: JsonValue[] = [];
    try {
      if (parsed.nullInput) {
        values = evaluate(null, ast, parsed.vars);
      } else if (parsed.slurp) {
        const all: JsonValue[] = [];
        for (const { content } of inputs) {
          const trimmed = content.trim();
          if (trimmed) all.push(...parseJsonStream(trimmed));
        }
        values = evaluate(all, ast, parsed.vars);
      } else {
        for (const { content } of inputs) {
          const trimmed = content.trim();
          if (!trimmed) continue;
          for (const doc of parseJsonStream(trimmed)) {
            values.push(...evaluate(doc, ast, parsed.vars));
          }
        }
      }
    } catch (e) {
      if (e instanceof JqRuntimeError) {
        return {
          stdout: "",
          stderr: `jq: error (at <stdin>): ${e.message}\n`,
          exitCode: 5,
        };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return {
        stdout: "",
        stderr: `jq: parse error: ${msg}\n`,
        exitCode: 5,
      };
    }

    const stdout = emitOutput(values, formatOpts, parsed.joinOutput);
    return {
      stdout,
      stderr: "",
      exitCode: exitFromValues(values, parsed.exitStatus),
    };
  },
};

function isFsError(e: unknown): e is FsError {
  return e instanceof FsError;
}
