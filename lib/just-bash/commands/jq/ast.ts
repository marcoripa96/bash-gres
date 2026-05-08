export type CmpOp = "==" | "!=" | ">" | ">=" | "<" | "<=";

export type Literal =
  | { type: "Lit"; value: string | number | boolean | null };

export type LogicalOp = "and" | "or";
export type ArithOp = "+" | "-" | "*" | "/" | "%";
export type AssignOp = "=" | "|=" | "+=" | "//=";

export type Filter =
  | { type: "Defs"; defs: FuncDef[]; body: Filter }
  | { type: "Identity" }
  | { type: "RecDescent" }
  | { type: "Field"; name: string; optional: boolean }
  | { type: "Index"; index: number; optional: boolean }
  | { type: "DynamicIndex"; key: Filter; optional: boolean }
  | { type: "Slice"; start: number | null; end: number | null }
  | { type: "Iter"; optional: boolean }
  | { type: "Comma"; left: Filter; right: Filter }
  | { type: "Pipe"; left: Filter; right: Filter }
  | { type: "Bind"; value: Filter; name: string; body: Filter }
  | { type: "Default"; left: Filter; right: Filter }
  | { type: "Compare"; op: CmpOp; left: Filter; right: Filter }
  | { type: "Logical"; op: LogicalOp; left: Filter; right: Filter }
  | { type: "Arith"; op: ArithOp; left: Filter; right: Filter }
  | { type: "If"; cond: Filter; thenBranch: Filter; elseBranch: Filter }
  | { type: "Try"; body: Filter; catchBody: Filter }
  | { type: "Assign"; op: AssignOp; path: Filter; value: Filter }
  | { type: "Builtin0"; name: Builtin0Name }
  | { type: "Has"; key: string }
  | { type: "Select"; cond: Filter }
  | { type: "Map"; body: Filter }
  | { type: "Paths"; pred: Filter }
  | { type: "Func"; name: FuncName; args: Filter[] }
  | { type: "UserCall"; name: string; args: Filter[] }
  | { type: "Del"; path: Filter }
  | { type: "StringPredicate"; kind: StringPredicateKind; arg: string }
  | { type: "StringTransform"; kind: StringTransformKind; arg: string }
  | { type: "RegexReplace"; kind: RegexReplaceKind; regex: string; replacement: string }
  | { type: "KeyAggregate"; kind: KeyAggregateKind; key: Filter }
  | { type: "ArrayCons"; elements: Filter[] }
  | { type: "ObjectCons"; pairs: Array<{ key: string | Filter; value: Filter }> }
  | { type: "StringInterp"; parts: Array<string | { expr: Filter }> }
  | { type: "FlattenN"; depth: number }
  | { type: "Format"; kind: FormatKind }
  | { type: "Generator"; kind: "first" | "last"; body: Filter }
  | { type: "Nth"; index: Filter; body: Filter }
  | { type: "Limit"; count: Filter; body: Filter }
  | { type: "Reduce"; source: Filter; name: string; init: Filter; update: Filter }
  | { type: "Foreach"; source: Filter; name: string; init: Filter; update: Filter; extract: Filter }
  | { type: "Var"; name: string }
  | { type: "Lit"; value: string | number | boolean | null };

export interface FuncDef {
  name: string;
  params: string[];
  body: Filter;
}

export type FormatKind = "csv" | "tsv" | "sh" | "uri" | "json" | "base64" | "base64d";

export type KeyAggregateKind = "sort_by" | "min_by" | "max_by" | "group_by";

export type StringPredicateKind = "startswith" | "endswith" | "test";
export type StringTransformKind =
  | "split"
  | "join"
  | "ltrimstr"
  | "rtrimstr";

export type RegexReplaceKind = "sub" | "gsub";

export type FuncName =
  | "contains"
  | "inside"
  | "index"
  | "rindex"
  | "indices"
  | "match"
  | "capture"
  | "scan"
  | "range"
  | "getpath"
  | "setpath"
  | "delpaths";

export type Builtin0Name =
  | "length"
  | "keys"
  | "keys_unsorted"
  | "values"
  | "type"
  | "not"
  | "empty"
  | "add"
  | "min"
  | "max"
  | "sort"
  | "unique"
  | "reverse"
  | "to_entries"
  | "from_entries"
  | "flatten"
  | "ascii_downcase"
  | "ascii_upcase"
  | "tostring"
  | "tonumber"
  | "tojson"
  | "fromjson"
  | "explode"
  | "implode"
  | "arrays"
  | "objects"
  | "iterables"
  | "booleans"
  | "numbers"
  | "strings"
  | "nulls"
  | "scalars"
  | "paths"
  | "leaf_paths";

export const BUILTIN0_NAMES: ReadonlySet<string> = new Set<Builtin0Name>([
  "length",
  "keys",
  "keys_unsorted",
  "values",
  "type",
  "not",
  "empty",
  "add",
  "min",
  "max",
  "sort",
  "unique",
  "reverse",
  "to_entries",
  "from_entries",
  "flatten",
  "ascii_downcase",
  "ascii_upcase",
  "tostring",
  "tonumber",
  "tojson",
  "fromjson",
  "explode",
  "implode",
  "arrays",
  "objects",
  "iterables",
  "booleans",
  "numbers",
  "strings",
  "nulls",
  "scalars",
  "paths",
  "leaf_paths",
]);

export type AggregateKind =
  | "length"
  | "sum"
  | "min"
  | "max"
  | "sort"
  | "unique"
  | "reverse"
  | "sort_by"
  | "min_by"
  | "max_by"
  | "group_by"
  | "to_entries"
  | "from_entries"
  | "flatten"
  | "ascii_downcase"
  | "ascii_upcase"
  | "tonumber"
  | "split"
  | "join"
  | "ltrimstr"
  | "rtrimstr"
  | "sub"
  | "gsub";
