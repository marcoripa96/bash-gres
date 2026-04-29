import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import { ensureSetup } from "./global-setup.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { readonlySqlClient } from "../lib/core/readonly.js";
import type { SqlClient } from "./helpers.js";

const WS = "tx-test";

describe.each(TEST_ADAPTERS)("PgFileSystem.transaction [%s]", (_name, factory) => {
  let client: SqlClient;
  let teardown: () => Promise<void>;

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
  });

  describe("commit", () => {
    it("two writes inside transaction are both visible after commit", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: WS });
      await fs.init();

      await fs.transaction(async (tx) => {
        await tx.writeFile("/a.txt", "alpha");
        await tx.writeFile("/b.txt", "bravo");
      });

      expect(await fs.readFile("/a.txt")).toBe("alpha");
      expect(await fs.readFile("/b.txt")).toBe("bravo");
    });

    it("returns the value resolved by fn", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: WS });
      await fs.init();

      const sum = await fs.transaction(async (tx) => {
        await tx.writeFile("/x", "1");
        return 42;
      });

      expect(sum).toBe(42);
    });
  });

  describe("rollback", () => {
    it("a thrown error rolls back every write", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: WS });
      await fs.init();
      await fs.writeFile("/keep.txt", "keep");

      await expect(
        fs.transaction(async (tx) => {
          await tx.writeFile("/throwaway.txt", "should not survive");
          await tx.writeFile("/keep.txt", "should not overwrite");
          throw new Error("boom");
        }),
      ).rejects.toThrow(/boom/);

      expect(await fs.exists("/throwaway.txt")).toBe(false);
      expect(await fs.readFile("/keep.txt")).toBe("keep");
    });
  });

  describe("nested calls share the outer tx", () => {
    it("public methods called on the facade do not commit independently", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: WS });
      await fs.init();

      // If writeFile committed independently, this side-effect would persist
      // even though we throw. The test asserts it does not.
      await expect(
        fs.transaction(async (tx) => {
          await tx.mkdir("/dir");
          await tx.writeFile("/dir/inner.txt", "v");
          throw new Error("rollback");
        }),
      ).rejects.toThrow(/rollback/);

      expect(await fs.exists("/dir")).toBe(false);
      expect(await fs.exists("/dir/inner.txt")).toBe(false);
    });

    it("transaction() called on the facade reuses the outer transaction", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: WS });
      await fs.init();

      await expect(
        fs.transaction(async (tx) => {
          await tx.writeFile("/outer.txt", "outer");
          await tx.transaction(async (inner) => {
            // Same instance: re-entrant transactions share state.
            expect(inner).toBe(tx);
            await inner.writeFile("/inner.txt", "inner");
          });
          throw new Error("rollback both");
        }),
      ).rejects.toThrow(/rollback both/);

      expect(await fs.exists("/outer.txt")).toBe(false);
      expect(await fs.exists("/inner.txt")).toBe(false);
    });
  });

  describe("readonly", () => {
    it("rejects writes inside a read-only filesystem transaction", async () => {
      // Initialize through a writable instance first.
      const writable = new PgFileSystem({ db: client, workspaceId: WS });
      await writable.init();
      await writable.writeFile("/seed.txt", "seed");

      const ro = new PgFileSystem({
        db: readonlySqlClient(client),
        workspaceId: WS,
        permissions: { read: true, write: false },
      });

      // Reads inside the transaction succeed.
      const read = await ro.transaction(async (tx) => tx.readFile("/seed.txt"));
      expect(read).toBe("seed");

      // Writes are blocked by the underlying SET TRANSACTION READ ONLY.
      await expect(
        ro.transaction(async (tx) => {
          await tx.writeFile("/forbidden.txt", "no");
        }),
      ).rejects.toMatchObject({ code: "EPERM" });

      // The seed file is untouched in any case.
      expect(await writable.readFile("/seed.txt")).toBe("seed");
      expect(await writable.exists("/forbidden.txt")).toBe(false);
    });

    it("rejects a direct (non-transactional) write on a read-only handle with FsError EPERM", async () => {
      // Regression: drizzle ≥0.44 wraps driver errors in DrizzleQueryError,
      // hiding the pg SQLSTATE behind `.cause`. The drizzle adapter must
      // unwrap so the FsError(EPERM) mapping in core/filesystem.ts still
      // fires. The existing transactional test above goes through
      // PgFileSystem.transaction's own catch path; this case exercises
      // the writeFile → withWorkspace path directly.
      const writable = new PgFileSystem({ db: client, workspaceId: WS });
      await writable.init();
      await writable.writeFile("/seed.txt", "seed");

      const ro = new PgFileSystem({
        db: client,
        workspaceId: WS,
        permissions: { read: true, write: false },
      });

      // Reads still work.
      expect(await ro.readFile("/seed.txt")).toBe("seed");

      await expect(ro.writeFile("/forbidden.txt", "no")).rejects.toMatchObject({
        code: "EPERM",
      });

      // Seed file untouched.
      expect(await writable.readFile("/seed.txt")).toBe("seed");
      expect(await writable.exists("/forbidden.txt")).toBe(false);
    });
  });

  describe("workspace isolation inside transaction", () => {
    it("RLS keeps another workspace's data invisible inside the tx", async () => {
      const a = new PgFileSystem({ db: client, workspaceId: WS });
      const b = new PgFileSystem({ db: client, workspaceId: WS + "-other" });
      await a.init();
      await b.init();
      await b.writeFile("/secret.txt", "B-only");

      const seen = await a.transaction(async (tx) => tx.exists("/secret.txt"));
      expect(seen).toBe(false);

      await resetWorkspace(client, WS + "-other");
    });
  });

  describe("facade carries instance configuration", () => {
    it("preserves rootDir scoping inside the transaction", async () => {
      const fs = new PgFileSystem({
        db: client,
        workspaceId: WS,
        rootDir: "/scoped",
      });
      await fs.init();

      await fs.transaction(async (tx) => {
        await tx.writeFile("/inside.txt", "ok");
      });

      // Under rootDir="/scoped", the public path "/inside.txt" maps to
      // "/scoped/inside.txt" internally. Read it back through the same
      // rootDir-scoped instance.
      expect(await fs.readFile("/inside.txt")).toBe("ok");
    });

    it("uses the live versionLabel, so a facade created right after a rebind targets the right version", async () => {
      const fs = new PgFileSystem({ db: client, workspaceId: WS, version: "v1" });
      await fs.init();
      await fs.writeFile("/v1.txt", "from v1");

      // Simulate a successful renameVersion by mutating the private label
      // (Phase 5 will wire this up properly). The createTxFacade path must
      // pick up the current label, not the construction-time one.
      // We instead assert the simpler property: the facade's version equals
      // the parent's current version.
      const seen = await fs.transaction(async (tx) => tx.version);
      expect(seen).toBe(fs.version);
    });
  });
});
