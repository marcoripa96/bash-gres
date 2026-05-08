import type { JsonValue } from "./evaluator.js";

export interface FormatOptions {
  compact: boolean;
  raw: boolean;
  sortKeys: boolean;
  useTab: boolean;
}

export function formatValue(
  v: JsonValue,
  opts: FormatOptions,
  indent = 0,
): string {
  return formatInner(v, opts, indent, opts.raw);
}

function formatInner(
  v: JsonValue,
  opts: FormatOptions,
  indent: number,
  raw: boolean,
): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "null";
    return String(v);
  }
  if (typeof v === "string") return raw ? v : JSON.stringify(v);

  const indentStr = opts.useTab ? "\t" : "  ";

  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (opts.compact) {
      return `[${v.map((x) => formatInner(x, opts, 0, false)).join(",")}]`;
    }
    const items = v.map(
      (x) =>
        indentStr.repeat(indent + 1) +
        formatInner(x, opts, indent + 1, false),
    );
    return `[\n${items.join(",\n")}\n${indentStr.repeat(indent)}]`;
  }

  // Object
  let keys = Object.keys(v as Record<string, JsonValue>);
  if (opts.sortKeys) keys = keys.sort();
  if (keys.length === 0) return "{}";
  const obj = v as Record<string, JsonValue>;
  if (opts.compact) {
    return `{${keys
      .map(
        (k) =>
          `${JSON.stringify(k)}:${formatInner(obj[k], opts, 0, false)}`,
      )
      .join(",")}}`;
  }
  const items = keys.map(
    (k) =>
      `${indentStr.repeat(indent + 1)}${JSON.stringify(k)}: ${formatInner(
        obj[k],
        opts,
        indent + 1,
        false,
      )}`,
  );
  return `{\n${items.join(",\n")}\n${indentStr.repeat(indent)}}`;
}
