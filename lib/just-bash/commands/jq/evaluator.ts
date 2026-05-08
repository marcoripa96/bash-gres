import { Buffer } from "node:buffer";
import type { CmpOp, Filter, FormatKind, FuncDef } from "./ast.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

type EvalEnv = ReadonlyMap<string, JsonValue>;
interface FuncEnvEntry {
  def: FuncDef;
  funcs: FuncEnv;
  params: FilterParamEnv;
}
type FuncEnv = ReadonlyMap<string, FuncEnvEntry>;
interface FilterParamValue {
  ast: Filter;
  env: EvalEnv;
  funcs: FuncEnv;
  params: FilterParamEnv;
}
type FilterParamEnv = ReadonlyMap<string, FilterParamValue>;

export class JqRuntimeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "JqRuntimeError";
  }
}

function jqTypeName(v: JsonValue): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  return "object";
}

function isTruthy(v: JsonValue): boolean {
  return v !== null && v !== false;
}

function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object") {
    if (typeof b !== "object" || Array.isArray(b)) return false;
    const ao = a as Record<string, JsonValue>;
    const bo = b as Record<string, JsonValue>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
      if (!deepEqual(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}

const TYPE_RANK: Record<string, number> = {
  null: 0,
  boolean: 1,
  number: 2,
  string: 3,
  array: 4,
  object: 5,
};

function jqCompare(a: JsonValue, b: JsonValue): number {
  const ta = jqTypeName(a);
  const tb = jqTypeName(b);
  if (ta !== tb) return TYPE_RANK[ta] - TYPE_RANK[tb];
  if (a === null && b === null) return 0;
  if (typeof a === "boolean" && typeof b === "boolean") {
    return a === b ? 0 : a ? 1 : -1;
  }
  if (typeof a === "number" && typeof b === "number") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const c = jqCompare(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  // objects: compare by sorted keys then values
  const ao = a as Record<string, JsonValue>;
  const bo = b as Record<string, JsonValue>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  const len = Math.min(ak.length, bk.length);
  for (let i = 0; i < len; i++) {
    if (ak[i] < bk[i]) return -1;
    if (ak[i] > bk[i]) return 1;
  }
  if (ak.length !== bk.length) return ak.length - bk.length;
  for (const k of ak) {
    const c = jqCompare(ao[k], bo[k]);
    if (c !== 0) return c;
  }
  return 0;
}

function applyCmp(op: CmpOp, a: JsonValue, b: JsonValue): boolean {
  switch (op) {
    case "==": return deepEqual(a, b);
    case "!=": return !deepEqual(a, b);
    case "<": return jqCompare(a, b) < 0;
    case "<=": return jqCompare(a, b) <= 0;
    case ">": return jqCompare(a, b) > 0;
    case ">=": return jqCompare(a, b) >= 0;
  }
}

function evalField(input: JsonValue, name: string, optional: boolean): JsonValue[] {
  if (input === null) return [null];
  if (typeof input === "object" && !Array.isArray(input)) {
    const v = (input as Record<string, JsonValue>)[name];
    return [v === undefined ? null : v];
  }
  if (optional) return [];
  throw new JqRuntimeError(
    `Cannot index ${jqTypeName(input)} with "${name}"`,
  );
}

function evalIndex(input: JsonValue, index: number, optional: boolean): JsonValue[] {
  if (input === null) return [null];
  if (Array.isArray(input)) {
    const len = input.length;
    const i = index < 0 ? len + index : index;
    if (i < 0 || i >= len) return [null];
    return [input[i]];
  }
  if (optional) return [];
  throw new JqRuntimeError(
    `Cannot index ${jqTypeName(input)} with number`,
  );
}

function evalDynamicIndex(input: JsonValue, keyFilter: Filter, optional: boolean, env: EvalEnv, funcs: FuncEnv, params: FilterParamEnv): JsonValue[] {
  const out: JsonValue[] = [];
  for (const key of evaluate(input, keyFilter, env, funcs, params)) {
    if (typeof key === "string") {
      out.push(...evalField(input, key, optional));
    } else if (typeof key === "number" && Number.isInteger(key)) {
      out.push(...evalIndex(input, key, optional));
    } else {
      if (optional) continue;
      throw new JqRuntimeError(
        `Cannot index ${jqTypeName(input)} with ${jqTypeName(key)}`,
      );
    }
  }
  return out;
}

function lookupVar(name: string, env: EvalEnv): JsonValue[] {
  if (!env.has(name)) {
    throw new JqRuntimeError(`$${name} is not defined`);
  }
  return [env.get(name)!];
}

function clampSliceBound(b: number | null, len: number, defaultIfNull: number): number {
  if (b === null) return defaultIfNull;
  const eff = b < 0 ? len + b : b;
  return Math.max(0, Math.min(len, eff));
}

function evalSlice(
  input: JsonValue,
  start: number | null,
  end: number | null,
): JsonValue[] {
  if (input === null) return [null];
  if (Array.isArray(input)) {
    const len = input.length;
    const a = clampSliceBound(start, len, 0);
    const b = clampSliceBound(end, len, len);
    return [a >= b ? [] : input.slice(a, b)];
  }
  if (typeof input === "string") {
    const arr = Array.from(input);
    const len = arr.length;
    const a = clampSliceBound(start, len, 0);
    const b = clampSliceBound(end, len, len);
    return [a >= b ? "" : arr.slice(a, b).join("")];
  }
  throw new JqRuntimeError(
    `Cannot slice ${jqTypeName(input)} (only arrays/strings)`,
  );
}

function evalIter(input: JsonValue, optional: boolean): JsonValue[] {
  if (Array.isArray(input)) return input.slice();
  if (input !== null && typeof input === "object") {
    return Object.values(input as Record<string, JsonValue>);
  }
  if (optional) return [];
  throw new JqRuntimeError(
    `Cannot iterate over ${jqTypeName(input)}`,
  );
}

function recDescent(input: JsonValue): JsonValue[] {
  const out: JsonValue[] = [input];
  if (Array.isArray(input)) {
    for (const v of input) out.push(...recDescent(v));
  } else if (input !== null && typeof input === "object") {
    for (const v of Object.values(input as Record<string, JsonValue>)) {
      out.push(...recDescent(v));
    }
  }
  return out;
}

function evalBuiltin0(name: string, input: JsonValue): JsonValue[] {
  switch (name) {
    case "length": {
      if (input === null) return [0];
      if (typeof input === "string") return [Array.from(input).length];
      if (Array.isArray(input)) return [input.length];
      if (typeof input === "number") return [Math.abs(input)];
      if (typeof input === "object") {
        return [Object.keys(input as Record<string, JsonValue>).length];
      }
      throw new JqRuntimeError(`length: bad input type ${jqTypeName(input)}`);
    }
    case "keys":
    case "keys_unsorted": {
      if (Array.isArray(input)) {
        return [input.map((_, i) => i)];
      }
      if (input !== null && typeof input === "object") {
        const ks = Object.keys(input as Record<string, JsonValue>);
        if (name === "keys") ks.sort();
        return [ks];
      }
      throw new JqRuntimeError(`${name}: bad input type ${jqTypeName(input)}`);
    }
    case "values": {
      // jq's `values` is a filter: emit input unchanged if it isn't null,
      // otherwise emit nothing.
      return input === null ? [] : [input];
    }
    case "type": return [jqTypeName(input)];
    case "not": return [!isTruthy(input)];
    case "empty": return [];
    case "add": return [jqAdd(input)];
    case "min": return [jqMinMax(input, true)];
    case "max": return [jqMinMax(input, false)];
    case "sort": return [jqSort(input)];
    case "unique": return [jqUnique(input)];
    case "reverse": return [jqReverse(input)];
    case "to_entries": return [jqToEntries(input)];
    case "from_entries": return [jqFromEntries(input)];
    case "flatten": return [jqFlatten(input, Infinity)];
    case "ascii_downcase": return [jqAsciiDowncase(input)];
    case "ascii_upcase": return [jqAsciiUpcase(input)];
    case "tostring": return [jqToString(input)];
    case "tonumber": return [jqToNumber(input)];
    case "tojson": return [JSON.stringify(input)];
    case "fromjson": return [jqFromJson(input)];
    case "explode": return [jqExplode(input)];
    case "implode": return [jqImplode(input)];
    case "arrays": return Array.isArray(input) ? [input] : [];
    case "objects": return input !== null && typeof input === "object" && !Array.isArray(input) ? [input] : [];
    case "iterables": return input !== null && typeof input === "object" ? [input] : [];
    case "booleans": return typeof input === "boolean" ? [input] : [];
    case "numbers": return typeof input === "number" ? [input] : [];
    case "strings": return typeof input === "string" ? [input] : [];
    case "nulls": return input === null ? [input] : [];
    case "scalars": return input === null || typeof input !== "object" ? [input] : [];
    case "paths": return jqPaths(input, false);
    case "leaf_paths": return jqPaths(input, true);
    default: throw new JqRuntimeError(`unsupported builtin: ${name}`);
  }
}

function formatJqFormat(
  kind: FormatKind,
  input: JsonValue,
): JsonValue {
  if (kind === "csv") return formatCsv(input);
  if (kind === "tsv") return formatTsv(input);
  if (kind === "sh") return formatSh(input);
  if (kind === "uri") return formatUri(input);
  if (kind === "json") return JSON.stringify(input);
  if (kind === "base64") return formatBase64(input);
  return formatBase64d(input);
}

function formatCsv(input: JsonValue): string {
  if (!Array.isArray(input)) {
    throw new JqRuntimeError(
      `@csv input must be array (got ${jqTypeName(input)})`,
    );
  }
  return input
    .map((v) => {
      if (v === null) return "";
      if (typeof v === "number") return String(v);
      if (typeof v === "boolean") return v ? "true" : "false";
      if (typeof v === "string") return `"${v.replace(/"/g, '""')}"`;
      throw new JqRuntimeError(`@csv: bad type ${jqTypeName(v)}`);
    })
    .join(",");
}

function formatTsv(input: JsonValue): string {
  if (!Array.isArray(input)) {
    throw new JqRuntimeError(
      `@tsv input must be array (got ${jqTypeName(input)})`,
    );
  }
  return input
    .map((v) => {
      if (v === null) return "";
      if (typeof v === "number") return String(v);
      if (typeof v === "boolean") return v ? "true" : "false";
      if (typeof v === "string") {
        return v
          .replace(/\\/g, "\\\\")
          .replace(/\t/g, "\\t")
          .replace(/\r/g, "\\r")
          .replace(/\n/g, "\\n");
      }
      throw new JqRuntimeError(`@tsv: bad type ${jqTypeName(v)}`);
    })
    .join("\t");
}

function formatSh(input: JsonValue): string {
  const fmt = (v: JsonValue): string => {
    if (typeof v === "string") return `'${v.replace(/'/g, "'\\''")}'`;
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return String(v);
    if (v === null) return "null";
    throw new JqRuntimeError(`@sh: cannot format ${jqTypeName(v)}`);
  };
  if (Array.isArray(input)) return input.map(fmt).join(" ");
  return fmt(input);
}

function formatUri(input: JsonValue): string {
  // RFC 3986 unreserved chars are kept as-is; everything else percent-
  // encoded byte-by-byte (UTF-8) — matches jq's @uri.
  const str = typeof input === "string" ? input : String(input);
  const enc = new TextEncoder();
  let out = "";
  for (const ch of str) {
    if (/^[A-Za-z0-9\-_.~]$/.test(ch)) {
      out += ch;
    } else {
      for (const b of enc.encode(ch)) {
        out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  return out;
}

function formatBase64(input: JsonValue): string {
  return Buffer.from(jqToString(input) as string, "utf8").toString("base64");
}

function formatBase64d(input: JsonValue): string {
  return Buffer.from(jqToString(input) as string, "base64").toString("utf8");
}

function jqPaths(input: JsonValue, leavesOnly: boolean): JsonValue[] {
  const out: JsonValue[] = [];
  const isContainer = (v: JsonValue) =>
    Array.isArray(v) || (v !== null && typeof v === "object");
  const walk = (val: JsonValue, prefix: JsonValue[]): void => {
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        const p = [...prefix, i];
        if (!leavesOnly || !isContainer(val[i])) out.push(p);
        walk(val[i], p);
      }
    } else if (val !== null && typeof val === "object") {
      for (const k of Object.keys(val as Record<string, JsonValue>)) {
        const p = [...prefix, k];
        const child = (val as Record<string, JsonValue>)[k];
        if (!leavesOnly || !isContainer(child)) out.push(p);
        walk(child, p);
      }
    }
  };
  walk(input, []);
  return out;
}

function jqPathsMatching(input: JsonValue, pred: Filter, env: EvalEnv, funcs: FuncEnv, params: FilterParamEnv): JsonValue[] {
  const out: JsonValue[] = [];
  const walk = (val: JsonValue, prefix: JsonValue[]): void => {
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        const child = val[i];
        const p = [...prefix, i];
        if (evaluate(child, pred, env, funcs, params).some(isTruthy)) out.push(p);
        walk(child, p);
      }
    } else if (val !== null && typeof val === "object") {
      for (const k of Object.keys(val as Record<string, JsonValue>)) {
        const child = (val as Record<string, JsonValue>)[k];
        const p = [...prefix, k];
        if (evaluate(child, pred, env, funcs, params).some(isTruthy)) out.push(p);
        walk(child, p);
      }
    }
  };
  walk(input, []);
  return out;
}

function expectString(input: JsonValue, name: string): string {
  if (typeof input !== "string") {
    throw new JqRuntimeError(
      `${name} input must be string (got ${jqTypeName(input)})`,
    );
  }
  return input;
}

function jqAsciiDowncase(input: JsonValue): JsonValue {
  return expectString(input, "ascii_downcase").replace(/[A-Z]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) + 32),
  );
}

function jqAsciiUpcase(input: JsonValue): JsonValue {
  return expectString(input, "ascii_upcase").replace(/[a-z]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 32),
  );
}

function jqToString(input: JsonValue): JsonValue {
  if (typeof input === "string") return input;
  return JSON.stringify(input);
}

function interpolateString(input: JsonValue, ast: Extract<Filter, { type: "StringInterp" }>, env: EvalEnv, funcs: FuncEnv, params: FilterParamEnv): JsonValue[] {
  let outputs = [""];
  for (const part of ast.parts) {
    if (typeof part === "string") {
      outputs = outputs.map((s) => s + part);
      continue;
    }
    const vals = evaluate(input, part.expr, env, funcs, params);
    const next: string[] = [];
    for (const prefix of outputs) {
      for (const v of vals) {
        next.push(prefix + (jqToString(v) as string));
      }
    }
    outputs = next;
  }
  return outputs;
}

function jqRegexReplace(
  input: JsonValue,
  kind: "sub" | "gsub",
  regex: string,
  replacement: string,
): JsonValue {
  const s = expectString(input, kind);
  const re = new RegExp(regex, kind === "gsub" ? "g" : undefined);
  return s.replace(re, () => replacement);
}

function jqToNumber(input: JsonValue): JsonValue {
  if (typeof input === "number") return input;
  if (typeof input === "string") {
    const n = Number(input);
    if (Number.isNaN(n)) {
      throw new JqRuntimeError(`string (${JSON.stringify(input)}) cannot be parsed as a number`);
    }
    return n;
  }
  throw new JqRuntimeError(
    `${jqTypeName(input)} cannot be parsed as number`,
  );
}

function jqFromJson(input: JsonValue): JsonValue {
  const s = expectString(input, "fromjson");
  try {
    return JSON.parse(s) as JsonValue;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new JqRuntimeError(msg);
  }
}

function jqExplode(input: JsonValue): JsonValue {
  return Array.from(expectString(input, "explode")).map((c) => c.codePointAt(0)!);
}

function jqImplode(input: JsonValue): JsonValue {
  if (!Array.isArray(input)) {
    throw new JqRuntimeError(
      `implode input must be array (got ${jqTypeName(input)})`,
    );
  }
  return input
    .map((c) => {
      if (typeof c !== "number") {
        throw new JqRuntimeError("implode: array must contain only codepoints");
      }
      return String.fromCodePoint(c);
    })
    .join("");
}

function jqToEntries(input: JsonValue): JsonValue {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new JqRuntimeError(
      `to_entries: input must be object (got ${jqTypeName(input)})`,
    );
  }
  const obj = input as Record<string, JsonValue>;
  const out: JsonValue[] = [];
  for (const k of Object.keys(obj)) {
    out.push({ key: k, value: obj[k] });
  }
  return out;
}

function jqFromEntries(input: JsonValue): JsonValue {
  if (!Array.isArray(input)) {
    throw new JqRuntimeError(
      `from_entries: input must be array (got ${jqTypeName(input)})`,
    );
  }
  const out: Record<string, JsonValue> = {};
  for (const entry of input) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new JqRuntimeError("from_entries: entries must be objects");
    }
    const e = entry as Record<string, JsonValue>;
    // jq accepts: {key, value}, {name, value}, {k, v}, {key}, {name}
    const k =
      e.key !== undefined
        ? e.key
        : e.name !== undefined
          ? e.name
          : e.k !== undefined
            ? e.k
            : null;
    const v =
      e.value !== undefined
        ? e.value
        : e.v !== undefined
          ? e.v
          : true;
    if (typeof k !== "string") {
      throw new JqRuntimeError("from_entries: key must be a string");
    }
    out[k] = v;
  }
  return out;
}

function jqFlatten(input: JsonValue, depth: number): JsonValue {
  if (!Array.isArray(input)) {
    throw new JqRuntimeError(
      `flatten: input must be array (got ${jqTypeName(input)})`,
    );
  }
  if (depth <= 0) return input.slice();
  const out: JsonValue[] = [];
  for (const v of input) {
    if (Array.isArray(v)) {
      const inner = jqFlatten(v, depth - 1);
      for (const x of inner as JsonValue[]) out.push(x);
    } else {
      out.push(v);
    }
  }
  return out;
}

function keyOf(v: JsonValue, key: import("./ast.js").Filter, env: EvalEnv, funcs: FuncEnv, params: FilterParamEnv): JsonValue {
  const ks = evaluate(v, key, env, funcs, params);
  return ks.length === 0 ? null : ks[0];
}

function applyArith(
  op: "+" | "-" | "*" | "/" | "%",
  a: JsonValue,
  b: JsonValue,
): JsonValue {
  if (op === "+") {
    if (a === null) return b;
    if (b === null) return a;
    if (typeof a === "number" && typeof b === "number") return a + b;
    if (typeof a === "string" && typeof b === "string") return a + b;
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
    if (
      typeof a === "object" &&
      typeof b === "object" &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      return {
        ...(a as Record<string, JsonValue>),
        ...(b as Record<string, JsonValue>),
      };
    }
    throw new JqRuntimeError(
      `${jqTypeName(a)} and ${jqTypeName(b)} cannot be added`,
    );
  }
  if (op === "-") {
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.filter((av) => !b.some((bv) => deepEqual(av, bv)));
    }
    throw new JqRuntimeError(
      `${jqTypeName(a)} and ${jqTypeName(b)} cannot be subtracted`,
    );
  }
  if (op === "*") {
    if (typeof a === "number" && typeof b === "number") return a * b;
    if (
      typeof a === "object" &&
      typeof b === "object" &&
      !Array.isArray(a) &&
      !Array.isArray(b) &&
      a !== null &&
      b !== null
    ) {
      return {
        ...(a as Record<string, JsonValue>),
        ...(b as Record<string, JsonValue>),
      };
    }
    throw new JqRuntimeError(
      `${jqTypeName(a)} and ${jqTypeName(b)} cannot be multiplied`,
    );
  }
  if (op === "/") {
    if (typeof a === "number" && typeof b === "number") {
      if (b === 0) throw new JqRuntimeError(`${a} and 0 cannot be divided`);
      return a / b;
    }
    throw new JqRuntimeError(
      `${jqTypeName(a)} and ${jqTypeName(b)} cannot be divided`,
    );
  }
  // %
  if (typeof a === "number" && typeof b === "number") {
    if (b === 0) throw new JqRuntimeError(`${a} and 0 cannot be divided`);
    return a % b;
  }
  throw new JqRuntimeError(
    `${jqTypeName(a)} and ${jqTypeName(b)} cannot be divided`,
  );
}

function expectArray(input: JsonValue, name: string): JsonValue[] {
  if (!Array.isArray(input)) {
    throw new JqRuntimeError(
      `${name} input must be array (got ${jqTypeName(input)})`,
    );
  }
  return input;
}

function jqSort(input: JsonValue): JsonValue {
  return expectArray(input, "sort").slice().sort(jqCompare);
}

function jqUnique(input: JsonValue): JsonValue {
  const sorted = expectArray(input, "unique").slice().sort(jqCompare);
  const out: JsonValue[] = [];
  for (const v of sorted) {
    if (out.length === 0 || !deepEqual(out[out.length - 1], v)) out.push(v);
  }
  return out;
}

function jqReverse(input: JsonValue): JsonValue {
  if (typeof input === "string") {
    return Array.from(input).reverse().join("");
  }
  return expectArray(input, "reverse").slice().reverse();
}

function jqAdd(input: JsonValue): JsonValue {
  if (input === null) return null;
  if (!Array.isArray(input)) {
    throw new JqRuntimeError(`Cannot iterate over ${jqTypeName(input)} (add)`);
  }
  if (input.length === 0) return null;
  let acc: JsonValue = input[0];
  for (let i = 1; i < input.length; i++) {
    acc = jqPlus(acc, input[i]);
  }
  return acc;
}

function jqPlus(a: JsonValue, b: JsonValue): JsonValue {
  if (a === null) return b;
  if (b === null) return a;
  if (typeof a === "number" && typeof b === "number") return a + b;
  if (typeof a === "string" && typeof b === "string") return a + b;
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    return {
      ...(a as Record<string, JsonValue>),
      ...(b as Record<string, JsonValue>),
    };
  }
  throw new JqRuntimeError(
    `${jqTypeName(a)} and ${jqTypeName(b)} cannot be added`,
  );
}

function jqMinMax(input: JsonValue, pickMin: boolean): JsonValue {
  if (!Array.isArray(input)) {
    throw new JqRuntimeError(
      `Cannot iterate over ${jqTypeName(input)} (${pickMin ? "min" : "max"})`,
    );
  }
  if (input.length === 0) return null;
  let best: JsonValue = input[0];
  for (let i = 1; i < input.length; i++) {
    const c = jqCompare(input[i], best);
    if ((pickMin && c < 0) || (!pickMin && c > 0)) best = input[i];
  }
  return best;
}

type PathStep =
  | { kind: "field"; name: string }
  | { kind: "index"; index: number };

function pathSteps(ast: Filter): PathStep[] | null {
  switch (ast.type) {
    case "Identity":
      return [];
    case "Field":
      return [{ kind: "field", name: ast.name }];
    case "Index":
      return [{ kind: "index", index: ast.index }];
    case "Pipe": {
      const left = pathSteps(ast.left);
      const right = pathSteps(ast.right);
      if (left === null || right === null) return null;
      return [...left, ...right];
    }
    default:
      return null;
  }
}

function pathStepVariants(input: JsonValue, ast: Filter, env: EvalEnv, funcs: FuncEnv, params: FilterParamEnv): PathStep[][] | null {
  switch (ast.type) {
    case "Identity":
      return [[]];
    case "Field":
      return [[{ kind: "field", name: ast.name }]];
    case "Index":
      return [[{ kind: "index", index: ast.index }]];
    case "DynamicIndex": {
      const out: PathStep[][] = [];
      for (const key of evaluate(input, ast.key, env, funcs, params)) {
        if (typeof key === "string") out.push([{ kind: "field", name: key }]);
        else if (typeof key === "number" && Number.isInteger(key)) out.push([{ kind: "index", index: key }]);
        else throw new JqRuntimeError("dynamic assignment index must be string or integer");
      }
      return out;
    }
    case "Pipe": {
      const lefts = pathStepVariants(input, ast.left, env, funcs, params);
      const rights = pathStepVariants(input, ast.right, env, funcs, params);
      if (lefts === null || rights === null) return null;
      const out: PathStep[][] = [];
      for (const l of lefts) for (const r of rights) out.push([...l, ...r]);
      return out;
    }
    default:
      return null;
  }
}

function objectRecord(v: JsonValue): Record<string, JsonValue> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, JsonValue>)
    : null;
}

function getPathValue(input: JsonValue, steps: PathStep[]): JsonValue {
  let cur = input;
  for (const step of steps) {
    if (step.kind === "field") {
      if (cur === null) return null;
      const obj = objectRecord(cur);
      if (obj === null) {
        throw new JqRuntimeError(
          `Cannot index ${jqTypeName(cur)} with string "${step.name}"`,
        );
      }
      cur = obj[step.name] ?? null;
    } else {
      if (cur === null) return null;
      if (!Array.isArray(cur)) {
        throw new JqRuntimeError(`Cannot index ${jqTypeName(cur)} with number`);
      }
      const idx = resolveArrayIndex(cur, step.index);
      cur = idx >= cur.length ? null : cur[idx];
    }
  }
  return cur;
}

function resolveArrayIndex(arr: JsonValue[], index: number): number {
  const idx = index < 0 ? arr.length + index : index;
  if (idx < 0) {
    throw new JqRuntimeError("Out of bounds negative array index");
  }
  return idx;
}

function emptyContainerFor(next: PathStep | undefined): JsonValue {
  return next?.kind === "index" ? [] : {};
}

function setPathValue(input: JsonValue, steps: PathStep[], value: JsonValue): JsonValue {
  if (steps.length === 0) return value;
  const [step, ...rest] = steps;
  if (step.kind === "field") {
    const base = input === null ? {} : objectRecord(input);
    if (base === null) {
      throw new JqRuntimeError(
        `Cannot index ${jqTypeName(input)} with string "${step.name}"`,
      );
    }
    const existing = base[step.name] ?? emptyContainerFor(rest[0]);
    return {
      ...base,
      [step.name]: setPathValue(existing, rest, value),
    };
  }
  const base = input === null ? [] : input;
  if (!Array.isArray(base)) {
    throw new JqRuntimeError(`Cannot index ${jqTypeName(input)} with number`);
  }
  const idx = resolveArrayIndex(base, step.index);
  const out = base.slice();
  while (out.length <= idx) out.push(null);
  const existing = out[idx] ?? emptyContainerFor(rest[0]);
  out[idx] = setPathValue(existing, rest, value);
  return out;
}

function deletePathValue(input: JsonValue, steps: PathStep[]): JsonValue {
  if (steps.length === 0) return null;
  const [step, ...rest] = steps;
  if (step.kind === "field") {
    if (input === null) return input;
    const obj = objectRecord(input);
    if (obj === null) {
      throw new JqRuntimeError(
        `Cannot index ${jqTypeName(input)} with string "${step.name}"`,
      );
    }
    if (rest.length === 0) {
      const remaining = { ...obj };
      delete remaining[step.name];
      return remaining;
    }
    if (!Object.prototype.hasOwnProperty.call(obj, step.name)) return input;
    return { ...obj, [step.name]: deletePathValue(obj[step.name], rest) };
  }
  if (input === null) return input;
  if (!Array.isArray(input)) {
    throw new JqRuntimeError(`Cannot index ${jqTypeName(input)} with number`);
  }
  const idx = resolveArrayIndex(input, step.index);
  if (idx >= input.length) return input;
  const out = input.slice();
  if (rest.length === 0) {
    out.splice(idx, 1);
  } else {
    out[idx] = deletePathValue(out[idx], rest);
  }
  return out;
}

function evalAssign(
  input: JsonValue,
  op: "=" | "|=" | "+=" | "//=",
  path: Filter,
  value: Filter,
  env: EvalEnv,
  funcs: FuncEnv,
  params: FilterParamEnv,
): JsonValue[] {
  const steps = pathSteps(path);
  const variants = steps === null ? pathStepVariants(input, path, env, funcs, params) : [steps];
  if (variants === null) {
    throw new JqRuntimeError("assignment path is not supported");
  }
  const out: JsonValue[] = [];
  for (const steps of variants) {
    const oldValue = getPathValue(input, steps);
  if (op === "|=") {
    const values = evaluate(oldValue, value, env, funcs, params);
      out.push(values.length === 0 ? deletePathValue(input, steps) : setPathValue(input, steps, values[0]));
      continue;
  }
  if (op === "//=") {
      if (isTruthy(oldValue)) out.push(input);
      else out.push(...evaluate(input, value, env, funcs, params).map((v) => setPathValue(input, steps, v)));
      continue;
  }
  const values = evaluate(input, value, env, funcs, params);
  if (op === "=") {
      out.push(...values.map((v) => setPathValue(input, steps, v)));
      continue;
  }
    out.push(...values.map((v) => setPathValue(input, steps, applyArith("+", oldValue, v))));
  }
  return out;
}

function pathArrayToSteps(path: JsonValue): PathStep[] {
  if (!Array.isArray(path)) {
    throw new JqRuntimeError(`path must be an array (got ${jqTypeName(path)})`);
  }
  return path.map((p) => {
    if (typeof p === "string") return { kind: "field", name: p };
    if (typeof p === "number" && Number.isInteger(p)) return { kind: "index", index: p };
    throw new JqRuntimeError("path elements must be strings or integers");
  });
}

function jqContains(input: JsonValue, needle: JsonValue): boolean {
  if (typeof input === "string" && typeof needle === "string") return input.includes(needle);
  if (Array.isArray(input) && Array.isArray(needle)) {
    return needle.every((n) => input.some((v) => jqContains(v, n)));
  }
  if (input !== null && needle !== null && typeof input === "object" && typeof needle === "object" && !Array.isArray(input) && !Array.isArray(needle)) {
    const obj = input as Record<string, JsonValue>;
    const sub = needle as Record<string, JsonValue>;
    return Object.keys(sub).every((k) => Object.prototype.hasOwnProperty.call(obj, k) && jqContains(obj[k], sub[k]));
  }
  return deepEqual(input, needle);
}

function findSubsequence(haystack: JsonValue[], needle: JsonValue[], reverse: boolean): number | null {
  if (needle.length === 0) return reverse ? haystack.length : 0;
  const start = reverse ? haystack.length - needle.length : 0;
  const end = reverse ? 0 : haystack.length - needle.length;
  for (let i = start; reverse ? i >= end : i <= end; reverse ? i-- : i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (!deepEqual(haystack[i + j], needle[j])) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return null;
}

function jqIndex(input: JsonValue, needle: JsonValue, reverse: boolean): JsonValue {
  if (typeof input === "string" && typeof needle === "string") {
    const idx = reverse ? input.lastIndexOf(needle) : input.indexOf(needle);
    return idx < 0 ? null : idx;
  }
  if (Array.isArray(input) && Array.isArray(needle)) return findSubsequence(input, needle, reverse);
  if (Array.isArray(input)) {
    const arrNeedle = [needle];
    return findSubsequence(input, arrNeedle, reverse);
  }
  throw new JqRuntimeError(`index input must be string or array (got ${jqTypeName(input)})`);
}

function jqIndices(input: JsonValue, needle: JsonValue): JsonValue {
  const out: JsonValue[] = [];
  if (typeof input === "string" && typeof needle === "string") {
    if (needle === "") return Array.from({ length: input.length + 1 }, (_, i) => i);
    let from = 0;
    while (from <= input.length) {
      const idx = input.indexOf(needle, from);
      if (idx < 0) break;
      out.push(idx);
      from = idx + needle.length;
    }
    return out;
  }
  if (Array.isArray(input)) {
    const arrNeedle = Array.isArray(needle) ? needle : [needle];
    if (arrNeedle.length === 0) return Array.from({ length: input.length + 1 }, (_, i) => i);
    for (let i = 0; i <= input.length - arrNeedle.length; i++) {
      let ok = true;
      for (let j = 0; j < arrNeedle.length; j++) {
        if (!deepEqual(input[i + j], arrNeedle[j])) {
          ok = false;
          break;
        }
      }
      if (ok) out.push(i);
    }
    return out;
  }
  throw new JqRuntimeError(`indices input must be string or array (got ${jqTypeName(input)})`);
}

function captureNames(regex: string): Array<string | null> {
  const names: Array<string | null> = [];
  let escaped = false;
  for (let i = 0; i < regex.length; i++) {
    const c = regex[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (c === "(" && regex[i + 1] !== "?") names.push(null);
    else if (regex.startsWith("(?<", i)) {
      const end = regex.indexOf(">", i + 3);
      names.push(end < 0 ? null : regex.slice(i + 3, end));
    }
  }
  return names;
}

function matchObject(input: string, regex: string): JsonValue[] {
  const re = new RegExp(regex);
  const m = re.exec(input);
  if (m === null || m.index === undefined) return [];
  const names = captureNames(regex);
  const captures: JsonValue[] = [];
  let searchFrom = m.index;
  for (let i = 1; i < m.length; i++) {
    const s = m[i];
    const name = names[i - 1] ?? null;
    if (s === undefined) {
      captures.push({ offset: -1, length: 0, string: null, name });
      continue;
    }
    const offset = input.indexOf(s, searchFrom);
    captures.push({ offset, length: Array.from(s).length, string: s, name });
    if (offset >= 0) searchFrom = offset + s.length;
  }
  return [{
    offset: Array.from(input.slice(0, m.index)).length,
    length: Array.from(m[0]).length,
    string: m[0],
    captures,
  }];
}

function jqCapture(input: string, regex: string): JsonValue[] {
  const matches = matchObject(input, regex);
  if (matches.length === 0) return [];
  const captures = (matches[0] as Record<string, JsonValue>).captures;
  const out: Record<string, JsonValue> = {};
  if (Array.isArray(captures)) {
    for (const c of captures) {
      if (c !== null && typeof c === "object" && !Array.isArray(c)) {
        const rec = c as Record<string, JsonValue>;
        if (typeof rec.name === "string") out[rec.name] = rec.string;
      }
    }
  }
  return [out];
}

function jqScan(input: string, regex: string): JsonValue[] {
  const re = new RegExp(regex, "g");
  const out: JsonValue[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (m.length === 1) out.push(m[0]);
    else out.push(m.slice(1).map((v) => v ?? null));
    if (m[0] === "") re.lastIndex++;
  }
  return out;
}

function evalRange(input: JsonValue, args: Filter[], env: EvalEnv, funcs: FuncEnv, params: FilterParamEnv): JsonValue[] {
  const argVals = args.map((arg) => evaluate(input, arg, env, funcs, params)[0]);
  const nums = argVals.map((v) => {
    if (typeof v !== "number") throw new JqRuntimeError("range arguments must be numbers");
    return v;
  });
  const start = nums.length === 1 ? 0 : nums[0];
  const end = nums.length === 1 ? nums[0] : nums[1];
  const step = nums.length === 3 ? nums[2] : 1;
  if (step === 0) throw new JqRuntimeError("range: step cannot be 0");
  const out: JsonValue[] = [];
  if (step > 0) {
    for (let n = start; n < end; n += step) out.push(n);
  } else {
    for (let n = start; n > end; n += step) out.push(n);
  }
  return out;
}

function evalFunc(input: JsonValue, ast: Extract<Filter, { type: "Func" }>, env: EvalEnv, funcs: FuncEnv, params: FilterParamEnv): JsonValue[] {
  if (ast.name === "range") return evalRange(input, ast.args, env, funcs, params);
  const firsts = evaluate(input, ast.args[0], env, funcs, params);
  if (ast.name === "setpath") {
    const seconds = evaluate(input, ast.args[1], env, funcs, params);
    const out: JsonValue[] = [];
    for (const p of firsts) {
      const steps = pathArrayToSteps(p);
      for (const v of seconds) out.push(setPathValue(input, steps, v));
    }
    return out;
  }
  const out: JsonValue[] = [];
  for (const arg of firsts) {
    switch (ast.name) {
      case "contains": out.push(jqContains(input, arg)); break;
      case "inside": out.push(jqContains(arg, input)); break;
      case "index": out.push(jqIndex(input, arg, false)); break;
      case "rindex": out.push(jqIndex(input, arg, true)); break;
      case "indices": out.push(jqIndices(input, arg)); break;
      case "match": out.push(...matchObject(expectString(input, "match"), expectString(arg, "match"))); break;
      case "capture": out.push(...jqCapture(expectString(input, "capture"), expectString(arg, "capture"))); break;
      case "scan": out.push(...jqScan(expectString(input, "scan"), expectString(arg, "scan"))); break;
      case "getpath": out.push(getPathValue(input, pathArrayToSteps(arg))); break;
      case "delpaths": {
        if (!Array.isArray(arg)) throw new JqRuntimeError("delpaths: argument must be an array of paths");
        let cur = input;
        for (const p of arg) cur = deletePathValue(cur, pathArrayToSteps(p));
        out.push(cur);
        break;
      }
    }
  }
  return out;
}

function evalDel(input: JsonValue, path: Filter, env: EvalEnv, funcs: FuncEnv, params: FilterParamEnv): JsonValue[] {
  const steps = pathSteps(path);
  const variants = steps === null ? pathStepVariants(input, path, env, funcs, params) : [steps];
  if (variants === null) throw new JqRuntimeError("del path is not supported");
  let cur = input;
  for (const v of variants) cur = deletePathValue(cur, v);
  return [cur];
}

export function evaluate(
  input: JsonValue,
  ast: Filter,
  env: EvalEnv = new Map(),
  funcs: FuncEnv = new Map(),
  params: FilterParamEnv = new Map(),
): JsonValue[] {
  switch (ast.type) {
    case "Identity": return [input];
    case "RecDescent": return recDescent(input);
    case "Lit": return [ast.value];
    case "Var": return lookupVar(ast.name, env);
    case "Field": return evalField(input, ast.name, ast.optional);
    case "Index": return evalIndex(input, ast.index, ast.optional);
    case "DynamicIndex": return evalDynamicIndex(input, ast.key, ast.optional, env, funcs, params);
    case "Slice": return evalSlice(input, ast.start, ast.end);
    case "Iter": return evalIter(input, ast.optional);
    case "Comma": {
      return [
        ...evaluate(input, ast.left, env, funcs, params),
        ...evaluate(input, ast.right, env, funcs, params),
      ];
    }
    case "Pipe": {
      const out: JsonValue[] = [];
      for (const v of evaluate(input, ast.left, env, funcs, params)) {
        out.push(...evaluate(v, ast.right, env, funcs, params));
      }
      return out;
    }
    case "Bind": {
      const out: JsonValue[] = [];
      for (const v of evaluate(input, ast.value, env, funcs, params)) {
        const nextEnv = new Map(env);
        nextEnv.set(ast.name, v);
        out.push(...evaluate(input, ast.body, nextEnv, funcs, params));
      }
      return out;
    }
    case "Default": {
      const left = evaluate(input, ast.left, env, funcs, params);
      const kept = left.filter(isTruthy);
      if (kept.length > 0) return kept;
      return evaluate(input, ast.right, env, funcs, params);
    }
    case "Compare": {
      const out: JsonValue[] = [];
      const lefts = evaluate(input, ast.left, env, funcs, params);
      const rights = evaluate(input, ast.right, env, funcs, params);
      for (const l of lefts) {
        for (const r of rights) {
          out.push(applyCmp(ast.op, l, r));
        }
      }
      return out;
    }
    case "Logical": {
      const out: JsonValue[] = [];
      const lefts = evaluate(input, ast.left, env, funcs, params);
      const rights = evaluate(input, ast.right, env, funcs, params);
      for (const l of lefts) {
        for (const r of rights) {
          const lt = isTruthy(l);
          const rt = isTruthy(r);
          out.push(ast.op === "and" ? lt && rt : lt || rt);
        }
      }
      return out;
    }
    case "Arith": {
      const out: JsonValue[] = [];
      for (const l of evaluate(input, ast.left, env, funcs, params)) {
        for (const r of evaluate(input, ast.right, env, funcs, params)) {
          out.push(applyArith(ast.op, l, r));
        }
      }
      return out;
    }
    case "If": {
      const out: JsonValue[] = [];
      for (const c of evaluate(input, ast.cond, env, funcs, params)) {
        out.push(
          ...evaluate(
            input,
            isTruthy(c) ? ast.thenBranch : ast.elseBranch,
            env,
            funcs,
            params,
          ),
        );
      }
      return out;
    }
    case "Try": {
      try {
        return evaluate(input, ast.body, env, funcs, params);
      } catch (e) {
        if (e instanceof JqRuntimeError) {
          return evaluate(e.message, ast.catchBody, env, funcs, params);
        }
        throw e;
      }
    }
    case "Assign":
      return evalAssign(input, ast.op, ast.path, ast.value, env, funcs, params);
    case "Builtin0": return evalBuiltin0(ast.name, input);
    case "Has": {
      if (Array.isArray(input)) {
        // jq spec: has(int) on arrays
        return [false];
      }
      if (input !== null && typeof input === "object") {
        return [Object.prototype.hasOwnProperty.call(input, ast.key)];
      }
      throw new JqRuntimeError(
        `has: cannot check ${jqTypeName(input)}`,
      );
    }
    case "Select": {
      const conds = evaluate(input, ast.cond, env, funcs, params);
      for (const c of conds) {
        if (isTruthy(c)) return [input];
      }
      return [];
    }
    case "Map": {
      if (!Array.isArray(input)) {
        throw new JqRuntimeError(
          `Cannot iterate over ${jqTypeName(input)} (map)`,
        );
      }
      const collected: JsonValue[] = [];
      for (const v of input) {
        collected.push(...evaluate(v, ast.body, env, funcs, params));
      }
      return [collected];
    }
    case "Paths":
      return jqPathsMatching(input, ast.pred, env, funcs, params);
    case "Func":
      return evalFunc(input, ast, env, funcs, params);
    case "Del":
      return evalDel(input, ast.path, env, funcs, params);
    case "StringPredicate": {
      if (typeof input !== "string") {
        throw new JqRuntimeError(
          `${ast.kind} requires string input (got ${jqTypeName(input)})`,
        );
      }
      switch (ast.kind) {
        case "startswith":
          return [input.startsWith(ast.arg)];
        case "endswith":
          return [input.endsWith(ast.arg)];
        case "test":
          return [new RegExp(ast.arg).test(input)];
      }
    }
    // eslint-disable-next-line no-fallthrough
    case "StringTransform": {
      switch (ast.kind) {
        case "split": {
          const s = expectString(input, "split");
          return [ast.arg === "" ? Array.from(s) : s.split(ast.arg)];
        }
        case "join": {
          if (!Array.isArray(input)) {
            throw new JqRuntimeError(
              `join input must be array (got ${jqTypeName(input)})`,
            );
          }
          return [
            input
              .map((v) => {
                if (v === null) return "";
                if (typeof v === "string") return v;
                throw new JqRuntimeError(
                  `join: array element must be string or null (got ${jqTypeName(v)})`,
                );
              })
              .join(ast.arg),
          ];
        }
        case "ltrimstr": {
          if (typeof input !== "string") return [input];
          return [input.startsWith(ast.arg) ? input.slice(ast.arg.length) : input];
        }
        case "rtrimstr": {
          if (typeof input !== "string") return [input];
          return [input.endsWith(ast.arg) ? input.slice(0, input.length - ast.arg.length) : input];
        }
      }
    }
    // eslint-disable-next-line no-fallthrough
    case "RegexReplace":
      return [jqRegexReplace(input, ast.kind, ast.regex, ast.replacement)];
    case "StringInterp":
      return interpolateString(input, ast, env, funcs, params);
    case "FlattenN":
      return [jqFlatten(input, ast.depth)];
    case "Format":
      return [formatJqFormat(ast.kind, input)];
    case "Generator": {
      const all = evaluate(input, ast.body, env, funcs, params);
      if (all.length === 0) return [];
      return [ast.kind === "first" ? all[0] : all[all.length - 1]];
    }
    case "Nth": {
      const ns = evaluate(input, ast.index, env, funcs, params);
      if (ns.length === 0 || typeof ns[0] !== "number") {
        throw new JqRuntimeError("nth: first arg must be a number");
      }
      const n = ns[0];
      const all = evaluate(input, ast.body, env, funcs, params);
      return n >= 0 && n < all.length ? [all[n]] : [];
    }
    case "Limit": {
      const ns = evaluate(input, ast.count, env, funcs, params);
      if (ns.length === 0 || typeof ns[0] !== "number") {
        throw new JqRuntimeError("limit: first arg must be a number");
      }
      const n = ns[0];
      if (n <= 0) return [];
      const all = evaluate(input, ast.body, env, funcs, params);
      return all.slice(0, n);
    }
    case "Reduce": {
      const source = evaluate(input, ast.source, env, funcs, params);
      let accumulators = evaluate(input, ast.init, env, funcs, params);
      for (const item of source) {
        const next: JsonValue[] = [];
        for (const acc of accumulators) {
          const nextEnv = new Map(env);
          nextEnv.set(ast.name, item);
          next.push(...evaluate(acc, ast.update, nextEnv, funcs, params));
        }
        accumulators = next;
      }
      return accumulators;
    }
    case "Foreach": {
      const source = evaluate(input, ast.source, env, funcs, params);
      let accumulators = evaluate(input, ast.init, env, funcs, params);
      const out: JsonValue[] = [];
      for (const item of source) {
        const updated: JsonValue[] = [];
        for (const acc of accumulators) {
          const nextEnv = new Map(env);
          nextEnv.set(ast.name, item);
          updated.push(...evaluate(acc, ast.update, nextEnv, funcs, params));
        }
        accumulators = updated;
        for (const acc of accumulators) {
          const nextEnv = new Map(env);
          nextEnv.set(ast.name, item);
          out.push(...evaluate(acc, ast.extract, nextEnv, funcs, params));
        }
      }
      return out;
    }
    case "ArrayCons": {
      const out: JsonValue[] = [];
      for (const element of ast.elements) {
        out.push(...evaluate(input, element, env, funcs, params));
      }
      return [out];
    }
    case "ObjectCons": {
      // Cartesian product over each value's emissions: jq emits one object
      // per combination. For the common `{k: <path>, ...}` case each value
      // emits exactly one result, so we emit a single object.
      let combos: Record<string, JsonValue>[] = [{}];
      for (const { key, value } of ast.pairs) {
        const keys: string[] = [];
        if (typeof key === "string") {
          keys.push(key);
        } else {
          for (const k of evaluate(input, key, env, funcs, params)) {
            if (typeof k !== "string") {
              throw new JqRuntimeError(`Cannot use ${jqTypeName(k)} (${String(k)}) as object key`);
            }
            keys.push(k);
          }
        }
        const vals = evaluate(input, value, env, funcs, params);
        const next: Record<string, JsonValue>[] = [];
        for (const c of combos) {
          for (const k of keys) {
            for (const v of vals) {
              next.push({ ...c, [k]: v });
            }
          }
        }
        combos = next;
      }
      return combos as JsonValue[];
    }
    case "KeyAggregate": {
      if (!Array.isArray(input)) {
        throw new JqRuntimeError(
          `${ast.kind} input must be array (got ${jqTypeName(input)})`,
        );
      }
      const decorated = input.map((v) => {
        const ks = evaluate(v, ast.key, env, funcs, params);
        return { v, k: ks.length === 0 ? (null as JsonValue) : ks[0] };
      });
      // group_by preserves *insertion* order within each group (jq behavior)
      // and sorts group keys for the outer order — same sort as sort_by.
      decorated.sort((a, b) => jqCompare(a.k, b.k));
      if (ast.kind === "sort_by") {
        return [decorated.map((d) => d.v)];
      }
      if (ast.kind === "group_by") {
        const groups: JsonValue[][] = [];
        for (const d of decorated) {
          const last = groups[groups.length - 1];
          if (
            groups.length > 0 &&
            deepEqual(
              keyOf(last[0], ast.key, env, funcs, params),
              keyOf(d.v, ast.key, env, funcs, params),
            )
          ) {
            last.push(d.v);
          } else {
            groups.push([d.v]);
          }
        }
        return [groups];
      }
      if (decorated.length === 0) return [null];
      return [
        ast.kind === "min_by"
          ? decorated[0].v
          : decorated[decorated.length - 1].v,
      ];
    }
    case "Defs": {
      const next = new Map(funcs);
      for (const def of ast.defs) {
        next.set(`${def.name}/${def.params.length}`, { def, funcs: next, params });
      }
      return evaluate(input, ast.body, env, next, params);
    }
    case "UserCall": {
      if (ast.args.length === 0) {
        const param = params.get(ast.name);
        if (param !== undefined) {
          return evaluate(input, param.ast, param.env, param.funcs, param.params);
        }
      }
      const entry = funcs.get(`${ast.name}/${ast.args.length}`);
      if (entry === undefined) {
        throw new JqRuntimeError(`${ast.name}/${ast.args.length} is not defined`);
      }
      const newParams = new Map(entry.params);
      for (let i = 0; i < entry.def.params.length; i++) {
        newParams.set(entry.def.params[i], {
          ast: ast.args[i],
          env,
          funcs,
          params,
        });
      }
      return evaluate(input, entry.def.body, env, entry.funcs, newParams);
    }
  }
}
