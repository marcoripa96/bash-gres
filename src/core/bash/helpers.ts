export function matchGlob(name: string, pattern: string): boolean {
  let regex = "^";
  for (const char of pattern) {
    if (char === "*") regex += ".*";
    else if (char === "?") regex += ".";
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  regex += "$";
  return new RegExp(regex).test(name);
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
