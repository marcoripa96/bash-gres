import { readFileSync } from "node:fs";
import path from "node:path";

let cached: string | null = null;

export function getSetupGuide(): string {
  if (cached) return cached;
  const guidePath = path.resolve(process.cwd(), "..", "SETUP-GUIDE.agents.md");
  cached = readFileSync(guidePath, "utf8");
  return cached;
}
