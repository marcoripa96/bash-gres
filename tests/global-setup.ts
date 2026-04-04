import { createTestClient } from "./helpers.js";
import { setup } from "../src/core/setup.js";

let initialized = false;

export async function ensureSetup(): Promise<void> {
  if (initialized) return;
  const { client, sql } = createTestClient();
  await setup(client, {
    enableRLS: false,
    enableFullTextSearch: false,
    enableVectorSearch: false,
  });
  await sql.end();
  initialized = true;
}
