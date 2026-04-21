import { readFileSync } from "node:fs";
import path from "node:path";

let cached: string | null = null;

export function getPackageVersion(): string {
  if (cached) return cached;
  const pkgPath = path.resolve(process.cwd(), "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  cached = pkg.version;
  return cached;
}
