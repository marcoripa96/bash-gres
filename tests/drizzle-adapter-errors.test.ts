import { describe, expect, it } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import { createDrizzleClient } from "../lib/adapters/drizzle/adapter.js";
import type { DrizzleDb } from "../lib/adapters/drizzle/adapter.js";
import { SqlError } from "../lib/core/types.js";

/** A drizzle db whose every query fails with `error`, wrapped as drizzle ≥0.44 does. */
function failingDb(error: Error): DrizzleDb {
  const db: DrizzleDb = {
    execute: () =>
      Promise.reject(new DrizzleQueryError("insert into fs_entries", [], error)),
    transaction: (fn) => fn(db),
  };
  return db;
}

/** The driver error fields that matter, set the way each driver sets them. */
function driverError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("cannot execute INSERT in a read-only transaction"), fields);
}

describe("drizzle adapter error mapping", () => {
  it.each([
    ["pg / postgres.js", { code: "25006" }],
    // Bun SQL (drizzle-orm/bun-sql): its own error kind in `code`, the SQLSTATE in `errno`.
    ["Bun SQL", { code: "ERR_POSTGRES_SERVER_ERROR", errno: "25006" }],
  ])("keeps the SQLSTATE of a %s error", async (_driver, fields) => {
    const client = createDrizzleClient(failingDb(driverError(fields)));

    const failure = await client.query("insert into fs_entries values ($1)", [1]).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SqlError);
    expect(failure).toMatchObject({ code: "25006" });
  });

  it("keeps the code of a Node system error, whose errno is a number", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      errno: -111,
    });
    const client = createDrizzleClient(failingDb(refused));

    const failure = await client.query("select 1").catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: "ECONNREFUSED" });
  });
});
