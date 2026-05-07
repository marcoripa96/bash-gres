// path-encoding's `encodeLabel` is not exported here; mirror the encoding for
// a single basename. The encoded last label of an ltree is exactly
// `encodeLabel(basename)`. Re-implemented inline to avoid leaking another
// export from path-encoding.
export function encodeBasenameForLtree(name: string): string {
  if (name.length === 0) throw new Error("Cannot encode empty basename");
  let result = "";
  for (const char of name) {
    if (char === "\0") throw new Error("Filenames cannot contain null bytes");
    if (/[A-Za-z0-9\-]/.test(char)) {
      result += char;
    } else {
      const hex = char
        .codePointAt(0)!
        .toString(16)
        .toUpperCase()
        .padStart(2, "0");
      result += `_x${hex}_`;
    }
  }
  return result;
}

export function globToRegex(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      regex += ".*";
      i += pattern[i + 2] === "/" ? 3 : 2;
    } else if (char === "*") {
      regex += "[^/]*";
      i++;
    } else if (char === "?") {
      regex += "[^/]";
      i++;
    } else if (char === "{") {
      const close = pattern.indexOf("}", i);
      if (close !== -1) {
        const options = pattern
          .slice(i + 1, close)
          .split(",")
          .map(escapeRegex)
          .join("|");
        regex += `(?:${options})`;
        i = close + 1;
      } else {
        regex += escapeRegex(char);
        i++;
      }
    } else {
      regex += escapeRegex(char);
      i++;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

export function globLiteralPrefix(pattern: string): string | null {
  const segments = pattern.split("/");
  const prefix: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") break;
    if (/[?*{]/.test(segment)) break;
    prefix.push(segment);
  }
  return prefix.length > 0 ? prefix.join("/") : null;
}

export function analyzeGlobPattern(
  pattern: string,
  literalPrefix: string | null,
): {
  exact: boolean;
  fixedDepth: number | null;
  basename: string | null;
} {
  const relative = stripGlobLiteralPrefix(pattern, literalPrefix);
  if (relative === "") {
    return { exact: true, fixedDepth: 0, basename: null };
  }
  const segments = relative.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? null;
  return {
    exact: false,
    fixedDepth: segments.includes("**") ? null : segments.length,
    basename:
      basename !== null && !/[?*{]/.test(basename) ? basename : null,
  };
}

function stripGlobLiteralPrefix(
  pattern: string,
  literalPrefix: string | null,
): string {
  if (!literalPrefix) return pattern;
  const prefixSegments = literalPrefix.split("/").filter(Boolean).length;
  return pattern.split("/").slice(prefixSegments).join("/");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
