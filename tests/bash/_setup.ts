import { beforeAll, afterAll, beforeEach } from "vitest";
import { ensureSetup } from "../global-setup.js";
import { PgFileSystem } from "../../src/core/filesystem.js";
import { BashInterpreter } from "../../src/core/bash/interpreter.js";
import type { SqlClient } from "../helpers.js";
import type { AdapterFactory } from "../helpers.js";

export function setupBash(workspaceId: string, adapterFactory?: AdapterFactory) {
  let client: SqlClient;
  let teardown: () => Promise<void>;
  let fs: PgFileSystem;
  let bash: BashInterpreter;

  beforeAll(async () => {
    await ensureSetup();
    if (adapterFactory) {
      const test = adapterFactory();
      client = test.client;
      teardown = test.teardown;
    } else {
      const { createTestClient } = await import("../helpers.js");
      const test = createTestClient();
      client = test.client;
      teardown = () => test.sql.end();
    }
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await client.query("DELETE FROM fs_nodes WHERE workspace_id = $1", [workspaceId]);
    fs = new PgFileSystem({ db: client, workspaceId });
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
