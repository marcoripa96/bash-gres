const MAX_LTREE_LABEL_LENGTH = 255;

export function encodeLabel(name: string): string {
  if (name.length === 0) throw new Error("Cannot encode empty filename");
  let result = "";
  for (const char of name) {
    if (char === "\0") throw new Error("Filenames cannot contain null bytes");
    if (/[A-Za-z0-9\-]/.test(char)) {
      result += char;
    } else {
      const hex = char.codePointAt(0)!.toString(16).toUpperCase().padStart(2, "0");
      result += `_x${hex}_`;
    }
  }
  if (result.length > MAX_LTREE_LABEL_LENGTH) {
    throw new Error(
      `Encoded filename exceeds ltree label limit of ${MAX_LTREE_LABEL_LENGTH} characters`,
    );
  }
  return result;
}

export function decodeLabel(label: string): string {
  return label.replace(/_x([0-9A-Fa-f]{2,6})_/g, (_match, hex) => {
    const code = parseInt(hex, 16);
    if (code === 0) return _match;
    return String.fromCodePoint(code);
  });
}

export function normalizePath(p: string): string {
  if (p.includes("\0")) throw new Error("Paths cannot contain null bytes");
  const parts = p.split("/").filter(Boolean);
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return "/" + resolved.join("/");
}

export function pathToLtree(posixPath: string, workspaceId: string): string {
  const normalized = normalizePath(posixPath);
  const segments = normalized.split("/").filter(Boolean);
  const prefix = `w_${encodeLabel(workspaceId)}`;
  if (segments.length === 0) return prefix;
  return prefix + "." + segments.map(encodeLabel).join(".");
}

export function ltreeToPath(ltree: string): string {
  const parts = ltree.split(".");
  // First part is the workspace prefix (w_<id>), skip it
  const segments = parts.slice(1);
  if (segments.length === 0) return "/";
  return "/" + segments.map(decodeLabel).join("/");
}

export function parentPath(posixPath: string): string {
  const parts = posixPath.split("/").filter(Boolean);
  if (parts.length <= 1) return "/";
  return "/" + parts.slice(0, -1).join("/");
}

export function fileName(posixPath: string): string {
  const parts = posixPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || "/";
}
