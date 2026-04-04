import { beforeAll, afterAll, beforeEach } from "vitest";
import { createTestClient } from "../helpers.js";
import { ensureSetup } from "../global-setup.js";
import { PgFileSystem } from "../../src/core/filesystem.js";
import { BashInterpreter } from "../../src/core/bash/interpreter.js";
import type { SqlClient } from "../helpers.js";
import type postgres from "postgres";

export function setupBash(workspaceId: string) {
  let sql: postgres.Sql;
  let db: SqlClient;
  let fs: PgFileSystem;
  let bash: BashInterpreter;

  beforeAll(async () => {
    await ensureSetup();
    const test = createTestClient();
    sql = test.sql;
    db = test.client;
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [workspaceId]);
    fs = new PgFileSystem({ db, workspaceId });
    await fs.init();
    bash = new BashInterpreter(fs);
  });

  return {
    get fs() {
      return fs;
    },
    get bash() {
      return bash;
    },
  };
}
