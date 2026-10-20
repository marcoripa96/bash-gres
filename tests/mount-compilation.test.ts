import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureSetup } from "./global-setup.js";
import { TEST_ADAPTERS, resetWorkspace } from "./helpers.js";
import type { SqlClient } from "./helpers.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import {
  compileMounts,
  type CompiledMounts,
  mountVisible,
  mountWritable,
  mountWhereSql,
} from "../lib/core/mounts.js";
import { normalizePath, pathToLtree } from "../lib/core/path-encoding.js";
import type { MountSpec, SqlParam } from "../lib/core/types.js";

// ---------------------------------------------------------------------------
// Mounts are compiled into per-depth root sets so a view with thousands of
// sibling mounts (one per assigned client) costs O(distinct depths) per check
// instead of O(mounts). These tests pin the new compilation to the original
// linear-scan semantics, then check it scales.
// ---------------------------------------------------------------------------

const WS = "mount-compilation-test";

// The original O(mounts) checks, kept as the reference oracle. They run over
// the roots `compileMounts` resolved and deduplicated, so the comparison
// isolates what changed: the per-depth grouping and the SQL it emits.
interface LegacyMounts {
  empty: boolean;
  entries: Array<{ root: string; readonly: boolean }>;
  ltrees: string[];
}

function legacyFrom(c: CompiledMounts, workspaceId: string): LegacyMounts {
  const entries = [...c.byRoot].map(([root, readonly]) => ({ root, readonly }));
  return {
    empty: c.empty,
    entries,
    ltrees: entries.map((e) => pathToLtree(e.root, workspaceId)),
  };
}

function isUnder(path: string, root: string): boolean {
  if (root === "/") return path.startsWith("/");
  return path === root || path.startsWith(root + "/");
}

function legacyVisible(c: LegacyMounts, path: string): boolean {
  if (c.empty || path === "/") return true;
  return c.entries.some((e) => isUnder(path, e.root) || isUnder(e.root, path));
}

function legacyWritable(c: LegacyMounts, path: string): boolean {
  if (c.empty) return true;
  let best: { root: string; readonly: boolean } | null = null;
  for (const e of c.entries) {
    if (!isUnder(path, e.root)) continue;
    if (!best || e.root.length > best.root.length) best = e;
  }
  return best !== null && !best.readonly;
}

function legacyWhereSql(
  c: LegacyMounts,
  pathExpr: string,
  i: number,
): { sql: string; params: SqlParam[] } {
  if (c.empty) return { sql: "TRUE", params: [] };
  return {
    sql: `(${pathExpr} <@ ANY($${i}::ltree[]) OR ${pathExpr} @> ANY($${i}::ltree[]))`,
    params: [c.ltrees],
  };
}

interface MountCase {
  name: string;
  rootDir: string;
  specs: MountSpec[];
}

const CASES: MountCase[] = [
  { name: "writable root only", rootDir: "/", specs: [{ path: "/" }] },
  {
    name: "readonly root",
    rootDir: "/",
    specs: [{ path: "/", readonly: true }],
  },
  {
    name: "writable root with readonly child and writable grandchild",
    rootDir: "/",
    specs: [
      { path: "/" },
      { path: "/general", readonly: true },
      { path: "/general/drafts" },
    ],
  },
  {
    name: "siblings at different depths, nested readonly under writable",
    rootDir: "/",
    specs: [
      { path: "/users/u1" },
      { path: "/general", readonly: true },
      { path: "/clienti/acme" },
      { path: "/clienti/acme/archive", readonly: true },
      { path: "/a/b/c/d" },
    ],
  },
  {
    name: "writable mount nested under readonly",
    rootDir: "/",
    specs: [{ path: "/p", readonly: true }, { path: "/p/q" }],
  },
  {
    name: "duplicate paths, writable wins in either order",
    rootDir: "/",
    specs: [
      { path: "/x", readonly: true },
      { path: "/x" },
      { path: "/y" },
      { path: "/y", readonly: true },
      { path: "/y/" },
    ],
  },
  {
    name: "labels that need encoding",
    rootDir: "/",
    specs: [
      { path: "/clients/ACME s.r.l." },
      { path: "/clients/è", readonly: true },
      { path: "/odd_name/x-y" },
    ],
  },
  {
    name: "non-root rootDir",
    rootDir: "/proj",
    specs: [
      { path: "/", readonly: true },
      { path: "/src" },
      { path: "/src/vendor", readonly: true },
    ],
  },
  {
    name: "non-root rootDir without a root mount",
    rootDir: "/proj",
    specs: [{ path: "/docs", readonly: true }, { path: "/src/app" }],
  },
];

/** Every mount root, its ancestors, descendants and prefix-confusable siblings. */
function pathUniverse(c: MountCase): string[] {
  const out = new Set<string>([
    "/",
    "/zzz",
    "/users",
    "/users/u2/chats",
    "/proj",
    "/proj/other",
    "/general2",
  ]);
  for (const spec of c.specs) {
    const user = normalizePath(spec.path);
    const bases = [user, c.rootDir === "/" ? user : normalizePath(c.rootDir + user)];
    for (const base of bases) {
      const segs = base.split("/").filter(Boolean);
      for (let d = 0; d <= segs.length; d++) out.add("/" + segs.slice(0, d).join("/"));
      const b = base === "/" ? "" : base;
      out.add(`${b}/child`);
      out.add(`${b}/child/deep/er`);
      if (base !== "/") {
        out.add(`${base}x`);
        out.add(`${base}x/child`);
        out.add(`${base}-sibling/child`);
      }
    }
  }
  return [...out].sort();
}

describe("mount compilation matches the linear-scan reference", () => {
  it("resolves and deduplicates mount roots", () => {
    const roots = (specs: MountSpec[], rootDir = "/") => [
      ...compileMounts(specs, rootDir, WS).byRoot,
    ];
    expect(compileMounts([], "/", WS).empty).toBe(true);
    expect(compileMounts([{ path: "/" }], "/", WS).empty).toBe(true);
    expect(compileMounts([{ path: "/" }, { path: "/a" }], "/", WS).empty).toBe(true);
    expect(compileMounts([{ path: "/", readonly: true }], "/", WS).empty).toBe(false);
    // A writable spec wins for a duplicate path, whichever comes first.
    expect(
      roots([
        { path: "/x", readonly: true },
        { path: "/x" },
        { path: "/y" },
        { path: "/y/", readonly: true },
      ]),
    ).toEqual([
      ["/x", false],
      ["/y", false],
    ]);
    expect(roots([{ path: "/", readonly: true }, { path: "/src/../lib" }], "/proj")).toEqual([
      ["/proj", true],
      ["/proj/lib", false],
    ]);
  });

  for (const c of CASES) {
    it(`mountVisible / mountWritable: ${c.name}`, () => {
      const next = compileMounts(c.specs, c.rootDir, WS);
      const legacy = legacyFrom(next, WS);
      for (const p of pathUniverse(c)) {
        expect([p, mountVisible(next, p)]).toEqual([p, legacyVisible(legacy, p)]);
        expect([p, mountWritable(next, p)]).toEqual([p, legacyWritable(legacy, p)]);
      }
    });
  }
});

/** Filter a literal set of ltree paths through a mount clause. */
async function filterPaths(
  client: SqlClient,
  paths: string[],
  clause: (pathExpr: string, idx: number) => { sql: string; params: SqlParam[] },
): Promise<string[]> {
  const mnt = clause("e.path", 2);
  const r = await client.query<{ p: string }>(
    `SELECT e.path::text AS p
       FROM (SELECT unnest($1::text[])::ltree AS path) e
      WHERE ${mnt.sql}`,
    [paths, ...mnt.params],
  );
  return r.rows.map((row) => row.p).sort();
}

const MOUNTED_CLIENTS = 4045;
const CLIENT_DIRS = 20000;

/** /shared plus one readonly mount per client dir, for the first 4045 clients. */
function manySiblingMounts(): MountSpec[] {
  return [
    { path: "/shared", readonly: true },
    ...Array.from({ length: MOUNTED_CLIENTS }, (_, i) => ({
      path: `/clients/c${i + 1}`,
      readonly: true,
    })),
  ];
}

// ~40.8k rows: 20k client dirs + one file each, 800 shared files, the dirs above.
const SIBLING_ROWS_SQL = `
  SELECT ('${pathToLtree("/", WS)}.' || p)::ltree AS path
  FROM (
    SELECT 'clients.c' || g AS p FROM generate_series(1, ${CLIENT_DIRS}) g
    UNION ALL SELECT 'clients.c' || g || '.f' FROM generate_series(1, ${CLIENT_DIRS}) g
    UNION ALL SELECT 'shared.s' || g FROM generate_series(1, 800) g
    UNION ALL SELECT unnest(ARRAY['clients', 'shared', 'other'])
  ) src`;
// Visible: mounted client dirs + their files, 800 shared files, /clients, /shared.
const SIBLING_VISIBLE = MOUNTED_CLIENTS * 2 + 800 + 2;

describe.each(TEST_ADAPTERS)("mount SQL [%s]", (_name, factory) => {
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

  for (const c of CASES) {
    it(`selects the same rows as the reference: ${c.name}`, async () => {
      const next = compileMounts(c.specs, c.rootDir, WS);
      const legacy = legacyFrom(next, WS);
      const universe = pathUniverse(c);
      const ltrees = universe.map((p) => pathToLtree(p, WS));

      const got = await filterPaths(client, ltrees, (e, i) => mountWhereSql(next, e, i));
      const want = await filterPaths(client, ltrees, (e, i) => legacyWhereSql(legacy, e, i));
      expect(got).toEqual(want);

      const viaJs = universe
        .filter((p) => mountVisible(next, p))
        .map((p) => pathToLtree(p, WS))
        .sort();
      expect(got).toEqual(viaJs);
    });
  }

  it("plans the membership tests as hashed subplans, custom or generic", async () => {
    const mnt = mountWhereSql(compileMounts(manySiblingMounts(), "/", WS), "e.path", 1);
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      const plan = await client.transaction(async (tx) => {
        await tx.query(`SET LOCAL plan_cache_mode = ${mode}`);
        const r = await tx.query<{ "QUERY PLAN": string }>(
          `EXPLAIN SELECT count(*) FROM (${SIBLING_ROWS_SQL}) e WHERE ${mnt.sql}`,
          mnt.params,
        );
        return r.rows.map((row) => row["QUERY PLAN"]).join("\n");
      });
      expect(plan).toMatch(/hashed SubPlan/);
      expect(plan).not.toMatch(/= ANY/);
    }
  });

  it("filters ~40k rows against 4046 mounts on every execution", async () => {
    const mnt = mountWhereSql(compileMounts(manySiblingMounts(), "/", WS), "e.path", 1);
    const sql = `SELECT count(*)::int AS n FROM (${SIBLING_ROWS_SQL}) e WHERE ${mnt.sql}`;
    // Ten runs push a reused prepared statement past the plan cache's switch
    // to a generic plan; the EXPLAIN test above pins the plan shape. The bound
    // is loose on purpose: the linear-scan form takes seconds at this size.
    let slowest = 0;
    for (let run = 0; run < 10; run++) {
      const start = performance.now();
      const r = await client.query<{ n: number }>(sql, mnt.params);
      slowest = Math.max(slowest, performance.now() - start);
      expect(r.rows[0]?.n).toBe(SIBLING_VISIBLE);
    }
    expect(slowest).toBeLessThan(1500);
  });

  it("serves a filesystem view with thousands of sibling mounts", async () => {
    await resetWorkspace(client, WS);
    const root = new PgFileSystem({ db: client, workspaceId: WS });
    await root.init();
    await root.mkdir("/shared", { recursive: true });
    await root.writeFile("/shared/policy.md", "policy\n");
    for (const code of ["c1", "c2", "c4045", "c4046", "c99999"]) {
      await root.mkdir(`/clients/${code}`, { recursive: true });
      await root.writeFile(`/clients/${code}/notes.md`, `${code}\n`);
    }
    await root.mkdir("/private", { recursive: true });

    const view = new PgFileSystem({ db: client, workspaceId: WS, mount: manySiblingMounts() });
    expect((await view.readdir("/")).sort()).toEqual(["clients", "shared"]);
    expect((await view.readdir("/clients")).sort()).toEqual(["c1", "c2", "c4045"]);
    expect(await view.readFile("/clients/c4045/notes.md")).toBe("c4045\n");
    await expect(view.readFile("/clients/c4046/notes.md")).rejects.toThrow(/ENOENT/);
    await expect(view.writeFile("/clients/c1/x.md", "x")).rejects.toThrow();
    expect(await view.exists("/private")).toBe(false);
  });
});
