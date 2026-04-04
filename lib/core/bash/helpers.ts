const globRegexCache = new Map<string, RegExp>();

export function matchGlob(name: string, pattern: string): boolean {
  let regex = globRegexCache.get(pattern);
  if (!regex) {
    let source = "^";
    for (const char of pattern) {
      if (char === "*") source += ".*";
      else if (char === "?") source += ".";
      else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    source += "$";
    regex = new RegExp(source);
    globRegexCache.set(pattern, regex);
  }
  return regex.test(name);
}

export function formatLong(
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
