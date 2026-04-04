export interface Redirect {
  type: ">" | ">>";
  target: string;
}

export interface ParsedCommand {
  command: string;
  args: string[];
  redirect: Redirect | null;
}

export interface OperatorSegment {
  op: string | null;
  cmd: string;
}

/**
 * Extracts redirect operators from the raw input string, respecting quotes.
 * Returns the main command string (without redirect) and the redirect info.
 */
export function extractRedirect(input: string): {
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

export function parseCommand(input: string): ParsedCommand | null {
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
export function tokenize(input: string): string[] {
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

export function splitPipe(input: string): string[] {
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

export function splitOperators(input: string): OperatorSegment[] {
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
