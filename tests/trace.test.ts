import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import type {
  TraceEvent,
  TraceOpEvent,
  TraceQueryEvent,
} from "../lib/core/types.js";
import type { SqlClient } from "./helpers.js";

const WS = "trace-workspace";

function queries(events: TraceEvent[]): TraceQueryEvent[] {
  return events.filter((e): e is TraceQueryEvent => e.type === "query");
}

function ops(events: TraceEvent[]): TraceOpEvent[] {
  return events.filter((e): e is TraceOpEvent => e.type === "op");
}

describe.each(TEST_ADAPTERS)("trace [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;
  let events: TraceEvent[];
  let fs: PgFileSystem;

  beforeAll(async () => {
    await ensureSetup();
    const test = factory();
    client = test.client;
    teardown = test.teardown;
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await resetWorkspace(client, WS);
    events = [];
    fs = new PgFileSystem({
      db: client,
      workspaceId: WS,
      trace: (e) => events.push(e),
    });
    await fs.init();
    await fs.writeFile("/a.txt", "alpha");
    await fs.writeFile("/b.txt", "beta");
    events.length = 0;
  });

  it("emits one op event per call, counting the queries it issued", async () => {
    expect(await fs.readFile("/a.txt")).toBe("alpha");

    const [op] = ops(events);
    expect(ops(events)).toHaveLength(1);
    expect(op).toMatchObject({
      name: "readFile",
      args: ["/a.txt"],
      parentId: null,
    });
    const qs = queries(events);
    expect(qs.length).toBeGreaterThan(0);
    expect(op!.queries).toBe(qs.length);
    for (const q of qs) expect(q.op).toEqual({ id: op!.id, name: "readFile" });
  });

  it("keeps concurrent calls apart", async () => {
    await Promise.all([
      fs.readFile("/a.txt"),
      fs.stat("/b.txt"),
      fs.exists("/missing.txt"),
    ]);

    const byId = new Map(ops(events).map((o) => [o.id, o]));
    expect([...byId.values()].map((o) => o.name).sort()).toEqual([
      "exists",
      "readFile",
      "stat",
    ]);
    for (const o of byId.values()) {
      const own = queries(events).filter((q) => q.op?.id === o.id);
      expect(own.length).toBe(o.queries);
      expect(o.queries).toBeGreaterThan(0);
    }
  });

  it("nests facade calls under transaction() and marks tx queries", async () => {
    await fs.transaction(async (tx) => {
      await tx.writeFile("/c.txt", "gamma");
      await tx.readFile("/c.txt");
    });

    const all = ops(events);
    const outer = all.find((o) => o.name === "transaction")!;
    expect(outer.parentId).toBeNull();
    const inner = all.filter((o) => o.parentId === outer.id);
    expect(inner.map((o) => o.name)).toEqual(["writeFile", "readFile"]);
    const innerIds = new Set(inner.map((o) => o.id));
    const txQueries = queries(events).filter((q) => innerIds.has(q.op!.id));
    expect(txQueries.length).toBeGreaterThan(0);
    expect(txQueries.every((q) => q.transaction)).toBe(true);
  });

  it("reports errors on both the op and the failing call", async () => {
    await expect(fs.readFile("/missing.txt")).rejects.toThrow(/ENOENT/);
    const [op] = ops(events);
    expect(op!.name).toBe("readFile");
    expect(op!.error).toBeDefined();
  });

  it("is inherited by forks", async () => {
    const child = await fs.fork("child");
    events.length = 0;
    await child.readFile("/a.txt");
    expect(ops(events).map((o) => o.name)).toEqual(["readFile"]);
  });

  it("survives a throwing sink", async () => {
    const noisy = new PgFileSystem({
      db: client,
      workspaceId: WS,
      trace: () => {
        throw new Error("sink exploded");
      },
    });
    expect(await noisy.readFile("/a.txt")).toBe("alpha");
  });

  it("shows the extra statements of a read-only instance", async () => {
    const ro = new PgFileSystem({
      db: client,
      workspaceId: WS,
      permissions: { read: true, write: false },
      trace: (e) => events.push(e),
    });
    events.length = 0;
    // Writes still run in the wrapper's READ ONLY transaction (plain reads
    // skip it), so the wrapper's own statement shows up in the trace.
    await expect(ro.writeFile("/b.txt", "nope")).rejects.toThrow("EPERM");
    const sqls = queries(events).map((q) => q.sql);
    expect(sqls).toContain("SET TRANSACTION READ ONLY");
  });

  it("does not change behavior when unset", async () => {
    const plain = new PgFileSystem({ db: client, workspaceId: WS });
    expect(Object.hasOwn(plain, "readFile")).toBe(false);
    expect(await plain.readFile("/a.txt")).toBe("alpha");
  });
});
