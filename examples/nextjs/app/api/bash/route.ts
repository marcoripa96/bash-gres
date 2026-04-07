import { Bash } from "just-bash";
import { PgFileSystem } from "bash-gres/drizzle";
import { db } from "@/src/db";

const WORKSPACE_ID = "demo";

export async function POST(request: Request) {
  const { command } = (await request.json()) as { command: string };

  if (!command || typeof command !== "string") {
    return Response.json({ error: "command is required" }, { status: 400 });
  }

  const fs = new PgFileSystem({ db, workspaceId: WORKSPACE_ID });
  const bash = new Bash({ fs });
  const result = await bash.exec(command);

  return Response.json(result);
}
