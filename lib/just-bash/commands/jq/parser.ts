import { BUILTIN0_NAMES, type AssignOp, type Builtin0Name, type CmpOp, type Filter, type FuncDef } from "./ast.js";

export class JqParseError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "JqParseError";
  }
}

interface ParserState {
  src: string;
  pos: number;
}

function peek(s: ParserState, n = 0): string {
  return s.src[s.pos + n] ?? "";
}

function eof(s: ParserState): boolean {
  return s.pos >= s.src.length;
}

function skipWs(s: ParserState): void {
  while (!eof(s) && /\s/.test(s.src[s.pos])) s.pos++;
}

function consume(s: ParserState, str: string): boolean {
  if (s.src.startsWith(str, s.pos)) {
    s.pos += str.length;
    return true;
  }
  return false;
}

function expect(s: ParserState, str: string): void {
  if (!consume(s, str)) {
    throw new JqParseError(
      `expected '${str}' at position ${s.pos}, got '${s.src.slice(s.pos, s.pos + 10)}'`,
    );
  }
}

function parseIdent(s: ParserState): string | null {
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.src.slice(s.pos));
  if (!m) return null;
  s.pos += m[0].length;
  return m[0];
}

function parseVarName(s: ParserState): string {
  skipWs(s);
  expect(s, "$");
  const name = parseIdent(s);
  if (name === null) {
    throw new JqParseError(`expected variable name at position ${s.pos}`);
  }
  return name;
}

function parseStringLit(s: ParserState): string {
  if (peek(s) !== '"') {
    throw new JqParseError(`expected string literal at position ${s.pos}`);
  }
  const start = s.pos;
  s.pos++;
  let out = "";
  while (!eof(s) && peek(s) !== '"') {
    const c = s.src[s.pos];
    if (c === "\\") {
      const next = s.src[s.pos + 1];
      switch (next) {
        case '"': out += '"'; s.pos += 2; break;
        case "\\": out += "\\"; s.pos += 2; break;
        case "/": out += "/"; s.pos += 2; break;
        case "n": out += "\n"; s.pos += 2; break;
        case "t": out += "\t"; s.pos += 2; break;
        case "r": out += "\r"; s.pos += 2; break;
        case "b": out += "\b"; s.pos += 2; break;
        case "f": out += "\f"; s.pos += 2; break;
        case "u": {
          const hex = s.src.slice(s.pos + 2, s.pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new JqParseError(`bad \\u escape at ${s.pos}`);
          }
          out += String.fromCharCode(parseInt(hex, 16));
          s.pos += 6;
          break;
        }
        default:
          throw new JqParseError(`bad escape \\${next} at ${s.pos}`);
      }
    } else {
      out += c;
      s.pos++;
    }
  }
  if (eof(s)) {
    throw new JqParseError(`unterminated string literal starting at ${start}`);
  }
  s.pos++; // closing quote
  return out;
}

function parseStringPrimary(s: ParserState): Filter {
  if (peek(s) !== '"') {
    throw new JqParseError(`expected string literal at position ${s.pos}`);
  }
  const start = s.pos;
  s.pos++;
  const parts: Array<string | { expr: Filter }> = [];
  let current = "";
  let hadInterpolation = false;
  const flush = (): void => {
    if (current.length > 0) {
      parts.push(current);
      current = "";
    }
  };
  while (!eof(s) && peek(s) !== '"') {
    const c = s.src[s.pos];
    if (c === "\\") {
      const next = s.src[s.pos + 1];
      if (next === "(") {
        hadInterpolation = true;
        flush();
        s.pos += 2;
        const inner = readInterpolationBody(s);
        parts.push({ expr: parseFilter(inner) });
        continue;
      }
      switch (next) {
        case '"': current += '"'; s.pos += 2; break;
        case "\\": current += "\\"; s.pos += 2; break;
        case "/": current += "/"; s.pos += 2; break;
        case "n": current += "\n"; s.pos += 2; break;
        case "t": current += "\t"; s.pos += 2; break;
        case "r": current += "\r"; s.pos += 2; break;
        case "b": current += "\b"; s.pos += 2; break;
        case "f": current += "\f"; s.pos += 2; break;
        case "u": {
          const hex = s.src.slice(s.pos + 2, s.pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new JqParseError(`bad \\u escape at ${s.pos}`);
          }
          current += String.fromCharCode(parseInt(hex, 16));
          s.pos += 6;
          break;
        }
        default:
          throw new JqParseError(`bad escape \\${next} at ${s.pos}`);
      }
    } else {
      current += c;
      s.pos++;
    }
  }
  if (eof(s)) {
    throw new JqParseError(`unterminated string literal starting at ${start}`);
  }
  s.pos++;
  flush();
  if (!hadInterpolation) {
    return { type: "Lit", value: parts.join("") };
  }
  if (parts.length === 1 && typeof parts[0] === "string") {
    return { type: "Lit", value: parts[0] };
  }
  return { type: "StringInterp", parts };
}

function readInterpolationBody(s: ParserState): string {
  const start = s.pos;
  let depth = 1;
  let inString = false;
  let escaped = false;
  while (!eof(s)) {
    const c = s.src[s.pos];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      s.pos++;
      continue;
    }
    if (c === '"') {
      inString = true;
      s.pos++;
      continue;
    }
    if (c === "(") {
      depth++;
      s.pos++;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth === 0) {
        const body = s.src.slice(start, s.pos);
        s.pos++;
        return body;
      }
      s.pos++;
      continue;
    }
    s.pos++;
  }
  throw new JqParseError(`unterminated interpolation starting at ${start - 2}`);
}

function parseNumberLit(s: ParserState): number {
  const m = /^-?(?:\d+\.\d+|\d+)(?:[eE][+-]?\d+)?/.exec(s.src.slice(s.pos));
  if (!m) throw new JqParseError(`expected number at position ${s.pos}`);
  s.pos += m[0].length;
  return Number(m[0]);
}

function parseLiteralValue(s: ParserState): string | number | boolean | null {
  skipWs(s);
  const c = peek(s);
  if (c === '"') return parseStringLit(s);
  if (c === "-" || (c >= "0" && c <= "9")) return parseNumberLit(s);
  if (consume(s, "true")) return true;
  if (consume(s, "false")) return false;
  if (consume(s, "null")) return null;
  throw new JqParseError(`expected literal at position ${s.pos}`);
}

// -- Grammar ----------------------------------------------------------------
//
//   expr    = bind
//   bind    = assign ('as' '$' ident '|' bind)?
//   assign  = comma (assignOp bind)?
//   comma   = pipe (',' pipe)*
//   pipe    = default ('|' default)*
//   default = orExpr ('//' orExpr)*
//   orExpr  = andExpr ('or' andExpr)*
//   andExpr = compare ('and' compare)*
//   compare = postfix (cmpOp postfix)?    -- at most one comparison
//   postfix = primary suffix*
//   primary = '..' | '.' suffixHead | identCallOrFn | literal | '(' expr ')'
//   suffix  = '.' field | '[' index? ']' | '?'

function parseExpr(s: ParserState): Filter {
  return parseBind(s);
}

function parseBind(s: ParserState): Filter {
  const value = parseAssign(s);
  skipWs(s);
  if (!matchKeyword(s, "as")) return value;
  const name = parseVarName(s);
  skipWs(s);
  expect(s, "|");
  const body = parseBind(s);
  return { type: "Bind", value, name, body };
}

function parseAssign(s: ParserState): Filter {
  const left = parseComma(s);
  skipWs(s);
  const op = parseAssignOp(s);
  if (op === null) return left;
  const value = parseBind(s);
  return { type: "Assign", op, path: left, value };
}

function parseAssignOp(s: ParserState): AssignOp | null {
  if (consume(s, "//=")) return "//=";
  if (consume(s, "|=")) return "|=";
  if (consume(s, "+=")) return "+=";
  if (peek(s) === "=" && peek(s, 1) !== "=") {
    s.pos++;
    return "=";
  }
  return null;
}

function parseComma(s: ParserState): Filter {
  let left = parsePipe(s);
  while (true) {
    skipWs(s);
    if (consume(s, ",")) {
      const right = parsePipe(s);
      left = { type: "Comma", left, right };
    } else break;
  }
  return left;
}

function parsePipe(s: ParserState): Filter {
  let left = parseDefault(s);
  while (true) {
    skipWs(s);
    if (peek(s) === "|" && peek(s, 1) !== "|" && peek(s, 1) !== "=") {
      s.pos++;
      const right = parseDefault(s);
      left = { type: "Pipe", left, right };
    } else break;
  }
  return left;
}

function parseDefault(s: ParserState): Filter {
  let left = parseOr(s);
  while (true) {
    skipWs(s);
    if (s.src.startsWith("//", s.pos) && peek(s, 2) !== "=") {
      s.pos += 2;
      const right = parseOr(s);
      left = { type: "Default", left, right };
    } else break;
  }
  return left;
}

function parseOr(s: ParserState): Filter {
  let left = parseAnd(s);
  while (true) {
    skipWs(s);
    if (matchKeyword(s, "or")) {
      const right = parseAnd(s);
      left = { type: "Logical", op: "or", left, right };
    } else break;
  }
  return left;
}

function parseAnd(s: ParserState): Filter {
  let left = parseCompare(s);
  while (true) {
    skipWs(s);
    if (matchKeyword(s, "and")) {
      const right = parseCompare(s);
      left = { type: "Logical", op: "and", left, right };
    } else break;
  }
  return left;
}

function matchKeyword(s: ParserState, kw: string): boolean {
  if (!s.src.startsWith(kw, s.pos)) return false;
  const next = s.src[s.pos + kw.length] ?? "";
  if (/[A-Za-z0-9_]/.test(next)) return false;
  s.pos += kw.length;
  return true;
}

function keywordAt(src: string, pos: number, kw: string): boolean {
  if (!src.startsWith(kw, pos)) return false;
  const before = src[pos - 1] ?? "";
  const after = src[pos + kw.length] ?? "";
  return !/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after);
}

function readUntilKeyword(
  s: ParserState,
  keywords: string[],
): { body: string; keyword: string } {
  const start = s.pos;
  let pos = s.pos;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let nestedIf = 0;
  let inString = false;
  let escaped = false;
  while (pos < s.src.length) {
    const c = s.src[pos];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      pos++;
      continue;
    }
    if (c === '"') {
      inString = true;
      pos++;
      continue;
    }
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === "[") bracket++;
    else if (c === "]") bracket--;
    else if (c === "{") brace++;
    else if (c === "}") brace--;
    const top = paren === 0 && bracket === 0 && brace === 0;
    if (top) {
      if (keywordAt(s.src, pos, "if")) nestedIf++;
      else if (keywordAt(s.src, pos, "end") && nestedIf > 0) nestedIf--;
      if (nestedIf === 0) {
        for (const kw of keywords) {
          if (keywordAt(s.src, pos, kw)) {
            const body = s.src.slice(start, pos).trim();
            s.pos = pos + kw.length;
            return { body, keyword: kw };
          }
        }
      }
    }
    pos++;
  }
  throw new JqParseError(`expected ${keywords.join(" or ")} at position ${start}`);
}

function readUntilTopLevelChar(s: ParserState, chars: string): { body: string; char: string } {
  const start = s.pos;
  let pos = s.pos;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let inString = false;
  let escaped = false;
  while (pos < s.src.length) {
    const c = s.src[pos];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      pos++;
      continue;
    }
    if (c === '"') {
      inString = true;
      pos++;
      continue;
    }
    if (chars.includes(c) && paren === 0 && bracket === 0 && brace === 0) {
      const body = s.src.slice(start, pos).trim();
      s.pos = pos + 1;
      return { body, char: c };
    }
    if (c === "(") paren++;
    else if (c === ")") {
      if (paren === 0 && chars.includes(")") && bracket === 0 && brace === 0) {
        const body = s.src.slice(start, pos).trim();
        s.pos = pos + 1;
        return { body, char: ")" };
      }
      paren--;
    } else if (c === "[") bracket++;
    else if (c === "]") bracket--;
    else if (c === "{") brace++;
    else if (c === "}") brace--;
    pos++;
  }
  throw new JqParseError(`expected one of '${chars}' at position ${start}`);
}

function parseIf(s: ParserState): Filter {
  const cond = parseFilter(readUntilKeyword(s, ["then"]).body);
  const thenPart = readUntilKeyword(s, ["elif", "else", "end"]);
  const thenBranch = parseFilter(thenPart.body);
  if (thenPart.keyword === "end") {
    return { type: "If", cond, thenBranch, elseBranch: { type: "Builtin0", name: "empty" } };
  }
  if (thenPart.keyword === "else") {
    const elsePart = readUntilKeyword(s, ["end"]);
    return { type: "If", cond, thenBranch, elseBranch: parseFilter(elsePart.body) };
  }
  // `elif c then t ...` is `else if c then t ... end`.
  const elseBranch = parseIf(s);
  return { type: "If", cond, thenBranch, elseBranch };
}

function parseTry(s: ParserState): Filter {
  const bodyPart = readUntilKeyword(s, ["catch"]);
  return {
    type: "Try",
    body: parseFilter(bodyPart.body),
    catchBody: parseExpr(s),
  };
}

function parseFold(s: ParserState, kind: "reduce" | "foreach"): Filter {
  const source = parseFilter(readUntilKeyword(s, ["as"]).body);
  const name = parseVarName(s);
  skipWs(s);
  expect(s, "(");
  const init = parseFilter(readUntilTopLevelChar(s, ";").body);
  const updateText = readUntilTopLevelChar(s, ";)");
  const update = parseFilter(updateText.body);
  if (kind === "reduce") {
    if (updateText.char !== ")") {
      throw new JqParseError("reduce() expects init and update expressions");
    }
    return { type: "Reduce", source, name, init, update };
  }
  const extract = updateText.char === ")"
    ? ({ type: "Identity" } as Filter)
    : parseFilter(readUntilTopLevelChar(s, ")").body);
  return { type: "Foreach", source, name, init, update, extract };
}

function parseCompare(s: ParserState): Filter {
  const left = parseAddExpr(s);
  skipWs(s);
  for (const op of ["==", "!=", "<=", ">=", "<", ">"] as const) {
    if (s.src.startsWith(op, s.pos)) {
      // Disambiguate `<` from `<=` etc by ordering above.
      s.pos += op.length;
      const right = parseAddExpr(s);
      return { type: "Compare", op, left, right };
    }
  }
  return left;
}

function parseAddExpr(s: ParserState): Filter {
  let left = parseMulExpr(s);
  while (true) {
    skipWs(s);
    const c = peek(s);
    if ((c === "+" && peek(s, 1) !== "=") || c === "-") {
      // Disambiguate from comparison `<=`/`>=` etc — those are caught at
      // parseCompare above. We're after a Mul-level expression here, so a
      // `-` at this position is binary subtraction.
      s.pos++;
      const right = parseMulExpr(s);
      left = { type: "Arith", op: c, left, right };
    } else break;
  }
  return left;
}

function parseMulExpr(s: ParserState): Filter {
  let left = parsePostfix(s);
  while (true) {
    skipWs(s);
    const c = peek(s);
    if (c === "*" || c === "/" || c === "%") {
      // `//` is the default operator (handled at parseDefault). Don't consume.
      if (c === "/" && peek(s, 1) === "/") break;
      s.pos++;
      const right = parsePostfix(s);
      left = { type: "Arith", op: c, left, right };
    } else break;
  }
  return left;
}

function parsePostfix(s: ParserState): Filter {
  let node = parsePrimary(s);
  while (true) {
    skipWs(s);
    const c = peek(s);
    if (c === "." && peek(s, 1) !== ".") {
      // .field or .["foo"]
      s.pos++;
      // Support `.["x"]` post-dot
      if (peek(s) === "[") {
        const sfx = parseBracketSuffix(s);
        const optional = consumeOptional(s);
        node = { type: "Pipe", left: node, right: applyOptional(sfx, optional) };
        continue;
      }
      const ident = parseIdent(s);
      if (ident === null) {
        throw new JqParseError(`expected field name at ${s.pos}`);
      }
      const optional = consumeOptional(s);
      node = {
        type: "Pipe",
        left: node,
        right: { type: "Field", name: ident, optional },
      };
    } else if (c === "[") {
      const sfx = parseBracketSuffix(s);
      const optional = consumeOptional(s);
      node = { type: "Pipe", left: node, right: applyOptional(sfx, optional) };
    } else if (c === "?") {
      s.pos++;
      node = {
        type: "Try",
        body: setOptionalOnTail(node),
        catchBody: { type: "Builtin0", name: "empty" },
      };
    } else break;
  }
  return node;
}

function consumeOptional(s: ParserState): boolean {
  skipWs(s);
  if (peek(s) === "?") {
    s.pos++;
    return true;
  }
  return false;
}

function applyOptional(f: Filter, optional: boolean): Filter {
  if (!optional) return f;
  if (f.type === "Field") return { ...f, optional: true };
  if (f.type === "Index") return { ...f, optional: true };
  if (f.type === "Iter") return { ...f, optional: true };
  return f;
}

function setOptionalOnTail(f: Filter): Filter {
  if (f.type === "Pipe") {
    return { type: "Pipe", left: f.left, right: setOptionalOnTail(f.right) };
  }
  return applyOptional(f, true);
}

function parseBracketSuffix(s: ParserState): Filter {
  expect(s, "[");
  skipWs(s);
  const exprStart = s.pos;
  if (consume(s, "]")) return { type: "Iter", optional: false };
  // String key: .["foo"]
  if (peek(s) === '"') {
    const name = parseStringLit(s);
    skipWs(s);
    if (consume(s, "]")) return { type: "Field", name, optional: false };
    s.pos = exprStart;
    const key = parseExpr(s);
    skipWs(s);
    expect(s, "]");
    return { type: "DynamicIndex", key, optional: false };
  }
  // .[:end] (no start)
  if (peek(s) === ":") {
    s.pos++;
    skipWs(s);
    if (consume(s, "]")) return { type: "Slice", start: null, end: null };
    const end = parseNumberLit(s);
    if (!Number.isInteger(end)) {
      throw new JqParseError(`slice bound must be integer, got ${end}`);
    }
    skipWs(s);
    expect(s, "]");
    return { type: "Slice", start: null, end };
  }
  if (peek(s) !== "-" && (peek(s) < "0" || peek(s) > "9")) {
    const key = parseExpr(s);
    skipWs(s);
    expect(s, "]");
    return { type: "DynamicIndex", key, optional: false };
  }
  // Numeric index or slice with start
  const n = parseNumberLit(s);
  if (!Number.isInteger(n)) {
    throw new JqParseError(`array index must be integer, got ${n}`);
  }
  skipWs(s);
  if (peek(s) === ":") {
    s.pos++;
    skipWs(s);
    if (consume(s, "]")) return { type: "Slice", start: n, end: null };
    const end = parseNumberLit(s);
    if (!Number.isInteger(end)) {
      throw new JqParseError(`slice bound must be integer, got ${end}`);
    }
    skipWs(s);
    expect(s, "]");
    return { type: "Slice", start: n, end };
  }
  if (consume(s, "]")) return { type: "Index", index: n, optional: false };
  s.pos = exprStart;
  const key = parseExpr(s);
  skipWs(s);
  expect(s, "]");
  return { type: "DynamicIndex", key, optional: false };
}

function parsePrimary(s: ParserState): Filter {
  skipWs(s);
  if (matchKeyword(s, "def")) {
    const defs: FuncDef[] = [parseFuncDef(s)];
    skipWs(s);
    while (matchKeyword(s, "def")) {
      defs.push(parseFuncDef(s));
      skipWs(s);
    }
    const body = parseExpr(s);
    return { type: "Defs", defs, body };
  }
  if (matchKeyword(s, "if")) {
    return parseIf(s);
  }
  if (matchKeyword(s, "try")) {
    return parseTry(s);
  }
  if (matchKeyword(s, "reduce")) {
    return parseFold(s, "reduce");
  }
  if (matchKeyword(s, "foreach")) {
    return parseFold(s, "foreach");
  }
  if (peek(s) === "$") {
    return { type: "Var", name: parseVarName(s) };
  }
  if (consume(s, "(")) {
    const inner = parseExpr(s);
    skipWs(s);
    expect(s, ")");
    return inner;
  }
  if (consume(s, "[")) {
    return parseArrayConstructor(s);
  }
  if (consume(s, "{")) {
    return parseObjectConstructor(s);
  }
  if (consume(s, "@")) {
    const ident = parseIdent(s);
    if (ident === null) {
      throw new JqParseError(`expected format name after '@' at ${s.pos}`);
    }
    if (
      ident !== "csv" &&
      ident !== "tsv" &&
      ident !== "sh" &&
      ident !== "uri" &&
      ident !== "json" &&
      ident !== "base64" &&
      ident !== "base64d"
    ) {
      throw new JqParseError(`unknown format directive @${ident}`);
    }
    return { type: "Format", kind: ident };
  }
  if (s.src.startsWith("..", s.pos)) {
    s.pos += 2;
    return { type: "RecDescent" };
  }
  if (peek(s) === ".") {
    s.pos++;
    // bare `.` -> identity, unless followed by something that makes it postfix
    skipWs(s);
    if (peek(s) === "[") {
      const sfx = parseBracketSuffix(s);
      const optional = consumeOptional(s);
      return applyOptional(sfx, optional);
    }
    const ident = parseIdent(s);
    if (ident !== null) {
      const optional = consumeOptional(s);
      return { type: "Field", name: ident, optional };
    }
    if (peek(s) === '"') {
      const name = parseStringLit(s);
      const optional = consumeOptional(s);
      return { type: "Field", name, optional };
    }
    return { type: "Identity" };
  }
  // Literals
  const c = peek(s);
  if (c === '"') {
    return parseStringPrimary(s);
  }
  if (c === "-" || (c >= "0" && c <= "9")) {
    return { type: "Lit", value: parseLiteralValue(s) };
  }
  // Identifier => builtin or function call
  const ident = parseIdent(s);
  if (ident !== null) {
    if (ident === "true") return { type: "Lit", value: true };
    if (ident === "false") return { type: "Lit", value: false };
    if (ident === "null") return { type: "Lit", value: null };
    skipWs(s);
    if (peek(s) === "(") {
      s.pos++;
      skipWs(s);
      const args: Filter[] = [];
      if (peek(s) !== ")") {
        args.push(parseExpr(s));
        skipWs(s);
        while (consume(s, ";")) {
          skipWs(s);
          args.push(parseExpr(s));
          skipWs(s);
        }
      }
      expect(s, ")");
      const expectArgs = (n: number): void => {
        if (args.length !== n) {
          throw new JqParseError(
            `${ident}() expects ${n} argument(s), got ${args.length}`,
          );
        }
      };
      const arg = args[0];
      if (ident === "select") {
        expectArgs(1);
        return { type: "Select", cond: arg };
      }
      if (ident === "has") {
        expectArgs(1);
        if (arg.type !== "Lit" || typeof arg.value !== "string") {
          throw new JqParseError("has() requires a string literal argument");
        }
        return { type: "Has", key: arg.value };
      }
      if (ident === "map") {
        expectArgs(1);
        return { type: "Map", body: arg };
      }
      if (ident === "paths") {
        expectArgs(1);
        return { type: "Paths", pred: arg };
      }
      if (ident === "del") {
        expectArgs(1);
        return { type: "Del", path: arg };
      }
      if (
        ident === "contains" ||
        ident === "inside" ||
        ident === "index" ||
        ident === "rindex" ||
        ident === "indices" ||
        ident === "match" ||
        ident === "capture" ||
        ident === "scan" ||
        ident === "range" ||
        ident === "getpath" ||
        ident === "setpath" ||
        ident === "delpaths"
      ) {
        if (ident === "setpath") expectArgs(2);
        else if (ident === "range") {
          if (args.length < 1 || args.length > 3) {
            throw new JqParseError(`range() expects 1 to 3 arguments, got ${args.length}`);
          }
        } else expectArgs(1);
        return { type: "Func", name: ident, args };
      }
      if (ident === "with_entries") {
        // Desugar: to_entries | map(f) | from_entries
        expectArgs(1);
        return {
          type: "Pipe",
          left: {
            type: "Pipe",
            left: { type: "Builtin0", name: "to_entries" },
            right: { type: "Map", body: arg },
          },
          right: { type: "Builtin0", name: "from_entries" },
        };
      }
      if (ident === "first") {
        expectArgs(1);
        return { type: "Generator", kind: "first", body: arg };
      }
      if (ident === "last") {
        expectArgs(1);
        return { type: "Generator", kind: "last", body: arg };
      }
      if (ident === "nth") {
        expectArgs(2);
        return { type: "Nth", index: args[0], body: args[1] };
      }
      if (ident === "limit") {
        expectArgs(2);
        return { type: "Limit", count: args[0], body: args[1] };
      }
      if (ident === "flatten") {
        expectArgs(1);
        if (
          arg.type !== "Lit" ||
          typeof arg.value !== "number" ||
          !Number.isInteger(arg.value) ||
          arg.value < 0
        ) {
          throw new JqParseError(
            "flatten() requires a non-negative integer literal",
          );
        }
        return { type: "FlattenN", depth: arg.value };
      }
      if (
        ident === "startswith" ||
        ident === "endswith" ||
        ident === "test"
      ) {
        expectArgs(1);
        if (arg.type !== "Lit" || typeof arg.value !== "string") {
          throw new JqParseError(`${ident}() requires a string literal argument`);
        }
        return { type: "StringPredicate", kind: ident, arg: arg.value };
      }
      if (
        ident === "split" ||
        ident === "join" ||
        ident === "ltrimstr" ||
        ident === "rtrimstr"
      ) {
        expectArgs(1);
        if (arg.type !== "Lit" || typeof arg.value !== "string") {
          throw new JqParseError(`${ident}() requires a string literal argument`);
        }
        return { type: "StringTransform", kind: ident, arg: arg.value };
      }
      if (ident === "sub" || ident === "gsub") {
        expectArgs(2);
        const replacement = args[1];
        if (arg.type !== "Lit" || typeof arg.value !== "string") {
          throw new JqParseError(`${ident}() requires a string literal regex`);
        }
        if (replacement.type !== "Lit" || typeof replacement.value !== "string") {
          throw new JqParseError(`${ident}() requires a string literal replacement`);
        }
        return {
          type: "RegexReplace",
          kind: ident,
          regex: arg.value,
          replacement: replacement.value,
        };
      }
      if (
        ident === "sort_by" ||
        ident === "min_by" ||
        ident === "max_by" ||
        ident === "group_by"
      ) {
        expectArgs(1);
        return { type: "KeyAggregate", kind: ident, key: arg };
      }
      return { type: "UserCall", name: ident, args };
    }
    // first / last are sugar for .[0] / .[-1]
    if (ident === "first") return { type: "Index", index: 0, optional: false };
    if (ident === "last") return { type: "Index", index: -1, optional: false };
    if (BUILTIN0_NAMES.has(ident)) {
      return { type: "Builtin0", name: ident as Builtin0Name };
    }
    return { type: "UserCall", name: ident, args: [] };
  }
  throw new JqParseError(
    `unexpected '${peek(s)}' at position ${s.pos}`,
  );
}

function parseArrayConstructor(s: ParserState): Filter {
  skipWs(s);
  if (consume(s, "]")) return { type: "ArrayCons", elements: [] };
  const elements: Filter[] = [];
  while (true) {
    elements.push(parsePipe(s));
    skipWs(s);
    if (consume(s, ",")) {
      skipWs(s);
      if (peek(s) === "]") {
        throw new JqParseError(`expected array element at position ${s.pos}`);
      }
      continue;
    }
    if (consume(s, "]")) break;
    throw new JqParseError(`expected ',' or ']' at position ${s.pos}`);
  }
  return { type: "ArrayCons", elements };
}

function parseObjectConstructor(s: ParserState): Filter {
  const pairs: Array<{ key: string | Filter; value: Filter }> = [];
  skipWs(s);
  if (consume(s, "}")) return { type: "ObjectCons", pairs };
  while (true) {
    skipWs(s);
    let key: string | Filter;
    if (consume(s, "(")) {
      key = parseExpr(s);
      skipWs(s);
      expect(s, ")");
    } else if (peek(s) === '"') {
      key = parseStringLit(s);
    } else {
      const ident = parseIdent(s);
      if (ident === null) {
        throw new JqParseError(
          `expected object key at position ${s.pos}`,
        );
      }
      key = ident;
    }
    skipWs(s);
    let value: Filter;
    if (consume(s, ":")) {
      skipWs(s);
      // Use parseDefault so we don't consume the comma (which separates pairs)
      // or pipe (typically not used inside `{}` either way).
      value = parseDefault(s);
    } else {
      if (typeof key !== "string") {
        throw new JqParseError(`expected ':' after dynamic object key at position ${s.pos}`);
      }
      value = { type: "Field", name: key, optional: false };
    }
    pairs.push({ key, value });
    skipWs(s);
    if (consume(s, ",")) continue;
    if (consume(s, "}")) break;
    throw new JqParseError(
      `expected ',' or '}' at position ${s.pos}`,
    );
  }
  return { type: "ObjectCons", pairs };
}

function parseFuncDef(s: ParserState): FuncDef {
  skipWs(s);
  const name = parseIdent(s);
  if (name === null) throw new JqParseError(`expected function name at position ${s.pos}`);
  const params: string[] = [];
  const valueParams: string[] = [];
  skipWs(s);
  if (consume(s, "(")) {
    skipWs(s);
    if (!consume(s, ")")) {
      while (true) {
        skipWs(s);
        const isValue = consume(s, "$");
        const p = parseIdent(s);
        if (p === null) throw new JqParseError(`expected parameter name at position ${s.pos}`);
        params.push(p);
        if (isValue) valueParams.push(p);
        skipWs(s);
        if (consume(s, ";")) {
          skipWs(s);
          continue;
        }
        expect(s, ")");
        break;
      }
    }
  }
  skipWs(s);
  expect(s, ":");
  let body = parseFilterContent(s);
  skipWs(s);
  expect(s, ";");
  // Desugar value-typed params `$x`: equivalent to `x as $x | body` for each.
  // Innermost binding closest to body, so we wrap right-to-left.
  for (let i = valueParams.length - 1; i >= 0; i--) {
    const v = valueParams[i];
    body = {
      type: "Bind",
      value: { type: "UserCall", name: v, args: [] },
      name: v,
      body,
    };
  }
  return { name, params, body };
}

function parseFilterContent(s: ParserState): Filter {
  skipWs(s);
  const defs: FuncDef[] = [];
  while (matchKeyword(s, "def")) {
    defs.push(parseFuncDef(s));
    skipWs(s);
  }
  const ast = parseExpr(s);
  return defs.length === 0 ? ast : { type: "Defs", defs, body: ast };
}

export function parseFilter(src: string): Filter {
  const s: ParserState = { src, pos: 0 };
  const ast = parseFilterContent(s);
  skipWs(s);
  if (!eof(s)) {
    throw new JqParseError(
      `unexpected trailing input '${s.src.slice(s.pos, s.pos + 16)}' at position ${s.pos}`,
    );
  }
  return ast;
}

export type { CmpOp };
