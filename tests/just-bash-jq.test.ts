import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Bash } from "just-bash";
import { ensureSetup } from "./global-setup.js";
import { createTestClient, resetWorkspace } from "./helpers.js";
import type { SqlClient } from "./helpers.js";
import { PgFileSystem } from "../lib/core/filesystem.js";
import { jqCommand } from "../lib/just-bash/index.js";

const NATIVE_JQ = (() => {
  for (const p of ["/usr/bin/jq", "/usr/local/bin/jq", "/opt/homebrew/bin/jq"]) {
    if (existsSync(p)) return p;
  }
  return null;
})();

interface JqResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runNativeJq(args: string[], stdin: string): JqResult {
  if (!NATIVE_JQ) throw new Error("native jq not available");
  const r = spawnSync(NATIVE_JQ, args, {
    input: stdin,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? 0,
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

const skipIfNoJq = NATIVE_JQ ? describe : describe.skip;

skipIfNoJq("just-bash jq vs native jq", () => {
  let client: SqlClient;
  let sqlEnd: () => Promise<void>;
  let pgFs: PgFileSystem;
  let bash: Bash;
  const wsId = "just-bash-jq-test";

  beforeAll(async () => {
    await ensureSetup();
    const t = createTestClient();
    client = t.client;
    sqlEnd = () => t.sql.end();
  });

  afterAll(async () => {
    await sqlEnd();
  });

  beforeEach(async () => {
    await resetWorkspace(client, wsId);
    pgFs = new PgFileSystem({ db: client, workspaceId: wsId });
    await pgFs.init();
    bash = new Bash({ fs: pgFs, customCommands: [jqCommand] });
  });

  // -- Helpers ---------------------------------------------------------------

  /**
   * Run `jq <args> <filter>` with stdin via bash-gres Bash and compare to native jq.
   * Both must produce the same stdout AND exitCode.
   */
  async function compareStdin(
    filter: string,
    stdin: string,
    extraArgs: string[] = [],
  ): Promise<void> {
    const native = runNativeJq([...extraArgs, filter], stdin);
    const cmd = `jq ${extraArgs.map(shellQuote).join(" ")} ${shellQuote(filter)}`;
    const ours = await bash.exec(cmd, { stdin });
    expect(
      { stdout: ours.stdout, exitCode: ours.exitCode },
      `filter=${filter} args=${JSON.stringify(extraArgs)} stdin=${stdin.slice(0, 80)}`,
    ).toEqual({ stdout: native.stdout, exitCode: native.exitCode });
  }

  /**
   * Same comparison, but feeds input via a file on the PgFileSystem.
   * This is the path that should trigger pushdown.
   */
  async function compareFile(
    filter: string,
    fileContent: string,
    extraArgs: string[] = [],
  ): Promise<void> {
    const native = runNativeJq([...extraArgs, filter], fileContent);
    await pgFs.writeFile("/data.json", fileContent);
    const cmd = `jq ${extraArgs.map(shellQuote).join(" ")} ${shellQuote(filter)} /data.json`;
    const ours = await bash.exec(cmd);
    expect(
      { stdout: ours.stdout, exitCode: ours.exitCode },
      `filter=${filter} args=${JSON.stringify(extraArgs)} file=/data.json`,
    ).toEqual({ stdout: native.stdout, exitCode: native.exitCode });
  }

  /** Run both file and stdin paths against the same expectation. */
  async function compareBoth(
    filter: string,
    content: string,
    extraArgs: string[] = [],
  ): Promise<void> {
    await compareStdin(filter, content, extraArgs);
    await compareFile(filter, content, extraArgs);
  }

  // -- Identity --------------------------------------------------------------

  describe("identity", () => {
    it("on object", async () => {
      await compareBoth(".", '{"hello":"world"}');
    });
    it("on array", async () => {
      await compareBoth(".", "[1,2,3]");
    });
    it("on string", async () => {
      await compareBoth(".", '"hello"');
    });
    it("on number", async () => {
      await compareBoth(".", "42");
    });
    it("on bool true", async () => {
      await compareBoth(".", "true");
    });
    it("on bool false", async () => {
      await compareBoth(".", "false");
    });
    it("on null", async () => {
      await compareBoth(".", "null");
    });
    it("on nested object", async () => {
      await compareBoth(".", '{"a":{"b":{"c":[1,2,3]}}}');
    });
  });

  // -- Field access ----------------------------------------------------------

  describe("field access", () => {
    const obj = '{"name":"Alice","age":30,"address":{"city":"NYC","zip":"10001"}}';
    it("simple field", async () => {
      await compareBoth(".name", obj);
    });
    it("nested field", async () => {
      await compareBoth(".address.city", obj);
    });
    it("missing field => null", async () => {
      await compareBoth(".missing", obj);
    });
    it("missing nested => error", async () => {
      // jq errors if you try to access a field on null without ?
      await compareBoth(".missing?.deeper", obj);
    });
    it("optional field", async () => {
      await compareBoth(".missing?", obj);
    });
    it("field then field", async () => {
      await compareBoth(".address | .city", obj);
    });
  });

  // -- Indexing --------------------------------------------------------------

  describe("indexing", () => {
    const arr = "[10,20,30,40,50]";
    it("first element", async () => {
      await compareBoth(".[0]", arr);
    });
    it("third element", async () => {
      await compareBoth(".[2]", arr);
    });
    it("negative index (-1)", async () => {
      await compareBoth(".[-1]", arr);
    });
    it("negative index (-2)", async () => {
      await compareBoth(".[-2]", arr);
    });
    it("out of range => null", async () => {
      await compareBoth(".[10]", arr);
    });
    it("field then index", async () => {
      await compareBoth(".items[1]", '{"items":["a","b","c"]}');
    });
  });

  // -- Iteration -------------------------------------------------------------

  describe("iteration", () => {
    it("array iter", async () => {
      await compareBoth(".[]", "[1,2,3]");
    });
    it("object value iter", async () => {
      await compareBoth(".[]", '{"a":1,"b":2,"c":3}');
    });
    it("field then iter", async () => {
      await compareBoth(".items[]", '{"items":[10,20,30]}');
    });
    it("iter then field", async () => {
      await compareBoth(
        ".[].name",
        '[{"name":"a"},{"name":"b"},{"name":"c"}]',
      );
    });
    it("iter then nested field", async () => {
      await compareBoth(
        ".users[].profile.email",
        '{"users":[{"profile":{"email":"a@x"}},{"profile":{"email":"b@x"}}]}',
      );
    });
  });

  // -- Recursive descent -----------------------------------------------------

  describe("recursive descent", () => {
    it("emit all subvalues", async () => {
      await compareBoth("..", '{"a":{"b":1}}');
    });
    it("on array of objects", async () => {
      await compareBoth("..", '[{"x":1},{"x":2}]');
    });
  });

  // -- Builtin functions -----------------------------------------------------

  describe("builtins", () => {
    it("length on string", async () => {
      await compareBoth("length", '"hello"');
    });
    it("length on array", async () => {
      await compareBoth("length", "[1,2,3,4]");
    });
    it("length on object", async () => {
      await compareBoth("length", '{"a":1,"b":2}');
    });
    it("length on null", async () => {
      await compareBoth("length", "null");
    });
    it("keys", async () => {
      await compareBoth("keys", '{"b":2,"a":1,"c":3}');
    });
    it("keys_unsorted", async () => {
      await compareBoth("keys_unsorted", '{"b":2,"a":1,"c":3}');
    });
    it("values", async () => {
      await compareBoth("values", '{"a":1,"b":2}');
    });
    it("type on object", async () => {
      await compareBoth("type", '{"x":1}');
    });
    it("type on array", async () => {
      await compareBoth("type", "[]");
    });
    it("type on string", async () => {
      await compareBoth("type", '"x"');
    });
    it("type on number", async () => {
      await compareBoth("type", "1");
    });
    it("type on bool", async () => {
      await compareBoth("type", "true");
    });
    it("type on null", async () => {
      await compareBoth("type", "null");
    });
    it("has true", async () => {
      await compareBoth('has("a")', '{"a":1,"b":2}');
    });
    it("has false", async () => {
      await compareBoth('has("z")', '{"a":1}');
    });
    it("empty", async () => {
      await compareBoth("empty", '{"a":1}');
    });
    it("not on true", async () => {
      await compareBoth("not", "true");
    });
    it("not on false", async () => {
      await compareBoth("not", "false");
    });
    it("not on null", async () => {
      await compareBoth("not", "null");
    });
    it("not on truthy obj", async () => {
      await compareBoth("not", '{"a":1}');
    });
  });

  // -- Pipes -----------------------------------------------------------------

  describe("pipes", () => {
    it("field then length", async () => {
      await compareBoth(".items | length", '{"items":[1,2,3]}');
    });
    it("iter then field", async () => {
      await compareBoth(
        ".[] | .name",
        '[{"name":"a"},{"name":"b"}]',
      );
    });
    it("multi-stage pipe", async () => {
      await compareBoth(
        ".users | .[] | .name",
        '{"users":[{"name":"a"},{"name":"b"}]}',
      );
    });
    it("recursive then type", async () => {
      await compareBoth(".. | type", '{"a":[1,"x"]}');
    });
  });

  // -- Default operator (//) -------------------------------------------------

  describe("default //", () => {
    it("missing fallback string", async () => {
      await compareBoth('.missing // "default"', '{"a":1}');
    });
    it("missing fallback number", async () => {
      await compareBoth(".missing // 0", '{"a":1}');
    });
    it("present overrides default", async () => {
      await compareBoth('.a // "default"', '{"a":1}');
    });
    it("null falls through", async () => {
      await compareBoth('.a // "fallback"', '{"a":null}');
    });
    it("false falls through", async () => {
      await compareBoth('.a // "fallback"', '{"a":false}');
    });
  });

  // -- select() --------------------------------------------------------------

  describe("select", () => {
    it("equality on number", async () => {
      await compareBoth(
        ".[] | select(.age == 30)",
        '[{"age":25},{"age":30},{"age":35}]',
      );
    });
    it("equality on string", async () => {
      await compareBoth(
        '.[] | select(.role == "admin")',
        '[{"role":"user"},{"role":"admin"},{"role":"guest"}]',
      );
    });
    it("greater than", async () => {
      await compareBoth(
        ".[] | select(.age > 30)",
        '[{"age":25},{"age":30},{"age":35},{"age":40}]',
      );
    });
    it("less than or equal", async () => {
      await compareBoth(
        ".[] | select(.score <= 50)",
        '[{"score":100},{"score":50},{"score":25}]',
      );
    });
    it("not equal", async () => {
      await compareBoth(
        '.[] | select(.role != "admin")',
        '[{"role":"user"},{"role":"admin"}]',
      );
    });
  });

  // -- Output flags ----------------------------------------------------------

  describe("flags", () => {
    it("-r raw string", async () => {
      await compareBoth(".name", '{"name":"Alice"}', ["-r"]);
    });
    it("-r raw nested string via pipe", async () => {
      await compareBoth(
        ".[] | .name",
        '[{"name":"Alice"},{"name":"Bob"}]',
        ["-r"],
      );
    });
    it("-c compact object", async () => {
      await compareBoth(".", '{"a":1,"b":[1,2,3]}', ["-c"]);
    });
    it("-c compact array", async () => {
      await compareBoth(".", "[1,2,3]", ["-c"]);
    });
    it("-S sort keys", async () => {
      await compareBoth(".", '{"b":2,"a":1,"c":3}', ["-S"]);
    });
    it("-c -S combined", async () => {
      await compareBoth(".", '{"b":2,"a":1,"c":3}', ["-c", "-S"]);
    });
    it("-n null input with literal", async () => {
      await compareBoth("null", "", ["-n"]);
    });
    it("-s slurp combines into array", async () => {
      // Native jq with -s wraps stdin (single doc here) into an array.
      await compareBoth(".", "[1,2,3]", ["-s"]);
    });
    it("-s slurp with iteration", async () => {
      await compareBoth(".[]", "[[1,2],[3,4]]", ["-s"]);
    });
  });

  // -- Output formatting (pretty print) --------------------------------------

  describe("pretty print", () => {
    it("nested object indented", async () => {
      await compareBoth(".", '{"a":{"b":1,"c":[2,3]}}');
    });
    it("array of objects indented", async () => {
      await compareBoth(".", '[{"x":1},{"y":2}]');
    });
    it("escapes special chars in strings", async () => {
      await compareBoth(".", '{"s":"line1\\nline2\\ttab"}');
    });
    it("unicode passthrough", async () => {
      await compareBoth(".", '{"s":"caf\\u00e9"}');
    });
  });

  // -- Extended pushdown shapes (parity check) -------------------------------

  describe("extended pushdown shapes", () => {
    it("negative indices [-1]", async () => {
      await compareBoth(".[-1]", "[10,20,30,40,50]");
    });
    it("negative indices [-2]", async () => {
      await compareBoth(".[-2]", "[10,20,30,40,50]");
    });
    it("negative index on field", async () => {
      await compareBoth(".items[-1]", '{"items":["a","b","c"]}');
    });
    it("Iter+select equality (file path)", async () => {
      await compareFile(
        ".[] | select(.age == 30)",
        '[{"age":25},{"age":30},{"age":35}]',
      );
    });
    it("Iter+select greater-than (file path)", async () => {
      await compareFile(
        ".[] | select(.age > 30)",
        '[{"age":25},{"age":30},{"age":35},{"age":40}]',
      );
    });
    it("Iter+select on nested field array (file path)", async () => {
      await compareFile(
        '.users[] | select(.role == "admin")',
        '{"users":[{"role":"user"},{"role":"admin"},{"role":"guest"}]}',
      );
    });
    it("partial pushdown: .users | length", async () => {
      await compareFile(
        ".users | length",
        '{"users":[1,2,3,4,5,6,7]}',
      );
    });
    it("partial pushdown: .users | keys (array indices)", async () => {
      await compareFile(
        ".users | keys",
        '{"users":[10,20,30]}',
      );
    });
    it("partial pushdown: .meta | type", async () => {
      await compareFile(
        ".meta | type",
        '{"meta":{"version":1}}',
      );
    });
    it("partial pushdown: default with present value", async () => {
      await compareFile(
        '.title // "untitled"',
        '{"title":"present"}',
      );
    });
    it("partial pushdown: default with missing value", async () => {
      await compareFile(
        '.title // "untitled"',
        '{"other":1}',
      );
    });
    it("Iter on object falls back to Node (insertion order preserved)", async () => {
      // Mixed-length keys: jsonb canonical order (length asc) ≠ insertion
      // order. Pushdown must NOT fire here so jq's insertion order is kept.
      await compareFile(".[]", '{"name":"Alice","age":30,"address":"x"}');
    });

    // -- Compound select conditions (and/or) ---------------------------------

    it("select(.a and .b) on file", async () => {
      await compareFile(
        ".[] | select(.active and .verified)",
        '[{"active":true,"verified":true},{"active":true,"verified":false},{"active":false,"verified":true}]',
      );
    });
    it("select(.a == X and .b == Y) on file", async () => {
      await compareFile(
        '.[] | select(.role == "admin" and .active == true)',
        '[{"role":"admin","active":true},{"role":"admin","active":false},{"role":"user","active":true}]',
      );
    });
    it("select(.a or .b) on file", async () => {
      await compareFile(
        ".[] | select(.flagA or .flagB)",
        '[{"flagA":true,"flagB":false},{"flagA":false,"flagB":true},{"flagA":false,"flagB":false}]',
      );
    });
    it("select with mixed and/or precedence", async () => {
      await compareFile(
        '.[] | select(.role == "admin" or .role == "owner" and .active)',
        '[{"role":"admin","active":false},{"role":"owner","active":false},{"role":"owner","active":true},{"role":"user","active":true}]',
      );
    });
    it("select(has(\"k\")) on file", async () => {
      await compareFile(
        '.[] | select(has("email"))',
        '[{"name":"a","email":"x"},{"name":"b"},{"name":"c","email":"z"}]',
      );
    });
    it("select(.x) truthy on file", async () => {
      await compareFile(
        ".[] | select(.deleted)",
        '[{"id":1,"deleted":true},{"id":2,"deleted":false},{"id":3}]',
      );
    });

    // -- map / first / last --------------------------------------------------

    it("map(.name) returns single array (file)", async () => {
      await compareFile(
        ".users | map(.name)",
        '{"users":[{"name":"Alice"},{"name":"Bob"},{"name":"Carol"}]}',
      );
    });
    it("map at root", async () => {
      await compareFile(
        "map(.id)",
        '[{"id":1},{"id":2},{"id":3}]',
      );
    });
    it("map with field projection (-c)", async () => {
      await compareFile(
        ".users | map(.email)",
        '{"users":[{"email":"a@x"},{"email":"b@x"}]}',
        ["-c"],
      );
    });
    it("first on array file", async () => {
      await compareFile(".users | first", '{"users":[10,20,30]}');
    });
    it("last on array file", async () => {
      await compareFile(".users | last", '{"users":[10,20,30]}');
    });
    it("first / last via stdin", async () => {
      await compareStdin("first", "[1,2,3]");
      await compareStdin("last", "[1,2,3]");
    });

    // -- SQL aggregations ----------------------------------------------------

    it(".users | length pushes a single number", async () => {
      await compareFile(".users | length", '{"users":[1,2,3,4,5,6,7]}');
    });
    it(".scores | add (numeric)", async () => {
      await compareFile(".scores | add", '{"scores":[10,20,30,40,50]}');
    });
    it(".scores | min (numeric)", async () => {
      await compareFile(".scores | min", '{"scores":[10,20,30,40,50]}');
    });
    it(".scores | max (numeric)", async () => {
      await compareFile(".scores | max", '{"scores":[10,20,30,40,50]}');
    });
    it("add on empty array → null", async () => {
      await compareFile(".items | add", '{"items":[]}');
    });
    it("min on empty array → null", async () => {
      await compareFile(".items | min", '{"items":[]}');
    });
    it(".tags | add (strings) falls back to Node and concatenates", async () => {
      await compareFile(".tags | add", '{"tags":["a","b","c"]}');
    });
    it(".lists | add (arrays) falls back to Node and flattens", async () => {
      await compareFile(".lists | add", '{"lists":[[1,2],[3,4],[5]]}');
    });

    // -- String predicates in select ----------------------------------------

    it("select startswith", async () => {
      await compareFile(
        '.[] | select(.name | startswith("A"))',
        '[{"name":"Alice"},{"name":"Bob"},{"name":"Andrew"}]',
      );
    });
    it("select endswith", async () => {
      await compareFile(
        '.[] | select(.path | endswith(".json"))',
        '[{"path":"a.json"},{"path":"b.txt"},{"path":"c.json"}]',
      );
    });
    it("select test (regex)", async () => {
      await compareFile(
        '.[] | select(.email | test("^a"))',
        '[{"email":"alice@x"},{"email":"bob@x"},{"email":"andrew@x"}]',
      );
    });

    // -- sort / unique / reverse aggregates ---------------------------------

    it(".items | sort (numeric)", async () => {
      await compareFile(".items | sort", '{"items":[3,1,4,1,5,9,2,6]}');
    });
    it(".tags | sort (strings)", async () => {
      await compareFile(".tags | sort", '{"tags":["banana","apple","cherry"]}');
    });
    it(".items | unique (numeric)", async () => {
      await compareFile(".items | unique", '{"items":[1,3,2,1,3,2]}');
    });
    it(".tags | unique (strings)", async () => {
      await compareFile(
        ".tags | unique",
        '{"tags":["b","a","c","b","a"]}',
      );
    });
    it(".items | reverse", async () => {
      await compareFile(".items | reverse", '{"items":[1,2,3,4,5]}');
    });
    it("reverse of mixed-type array", async () => {
      // reverse works on any array; pushdown handles it without type guard.
      await compareFile(
        ".items | reverse",
        '{"items":[1,"two",[3],{"k":4}]}',
      );
    });
    it("sort of mixed-type array → falls back to Node", async () => {
      // SQL agg returns NULL for mixed types; Node handles it.
      await compareFile(
        ".items | sort",
        '{"items":[2,"a",1,"b"]}',
      );
    });

    // -- Keyed aggregates ---------------------------------------------------

    // sort_by/min_by/max_by emit objects whose key order is canonicalized
    // by Postgres jsonb (length asc, then alpha). We pass `-S` so native jq
    // also canonicalizes (alpha) — for our test inputs the two orders agree.
    // Document: in production, downstream projection (e.g. `.name`) hides
    // the difference.
    it("sort_by(.age)", async () => {
      await compareFile(
        ".users | sort_by(.age)",
        '{"users":[{"name":"a","age":35},{"name":"b","age":25},{"name":"c","age":30}]}',
        ["-S"],
      );
    });
    it("sort_by(.name) (string key)", async () => {
      await compareFile(
        ".users | sort_by(.name)",
        '{"users":[{"name":"banana","age":1},{"name":"apple","age":2}]}',
        ["-S"],
      );
    });
    it("min_by(.score)", async () => {
      await compareFile(
        ".users | min_by(.score)",
        '{"users":[{"id":1,"score":50},{"id":2,"score":10},{"id":3,"score":30}]}',
        ["-S"],
      );
    });
    it("max_by(.score)", async () => {
      await compareFile(
        ".users | max_by(.score)",
        '{"users":[{"id":1,"score":50},{"id":2,"score":10},{"id":3,"score":30}]}',
        ["-S"],
      );
    });
    it("min_by on empty array → null", async () => {
      await compareFile(".users | min_by(.score)", '{"users":[]}');
    });
    it("sort_by with mixed-type keys falls back to Node", async () => {
      // Some elements have numeric .k, some have string .k → SQL returns
      // NULL → Node fallback applies jq's full type-aware ordering.
      await compareFile(
        ".items | sort_by(.k)",
        '{"items":[{"k":3},{"k":"apple"},{"k":1}]}',
      );
    });

    // -- Array slicing ------------------------------------------------------

    it("slice .users[1:3]", async () => {
      await compareFile(".users[1:3]", '{"users":[10,20,30,40,50]}');
    });
    it("slice .users[2:]", async () => {
      await compareFile(".users[2:]", '{"users":[10,20,30,40,50]}');
    });
    it("slice .users[:3]", async () => {
      await compareFile(".users[:3]", '{"users":[10,20,30,40,50]}');
    });
    it("root slice .[1:4]", async () => {
      await compareFile(".[1:4]", "[10,20,30,40,50]");
    });
    it("slice with negative bounds (Node fallback)", async () => {
      await compareFile(".users[-2:]", '{"users":[10,20,30,40,50]}');
    });
    it("slice empty range", async () => {
      await compareFile(".users[3:1]", '{"users":[10,20,30,40,50]}');
    });

    // -- Object construction -----------------------------------------------

    it("bare {a: .x, b: .y} on object", async () => {
      // ObjectCons emit + values come from same input; -S to normalize keys.
      await compareFile(
        '{n: .name, a: .age}',
        '{"name":"Alice","age":30,"role":"admin"}',
        ["-S"],
      );
    });
    it("object constructor shorthand", async () => {
      await compareFile(
        "{id, name}",
        '{"id":1,"name":"Alice","extra":true}',
        ["-S"],
      );
    });
    it("object constructor mixed shorthand and explicit values", async () => {
      await compareFile(
        "{id, label: .name}",
        '{"id":1,"name":"Alice"}',
        ["-S"],
      );
    });
    it("object constructor quoted shorthand", async () => {
      await compareFile('{"weird key"}', '{"weird key":42}', ["-S"]);
    });
    it("object constructor dynamic key", async () => {
      await compareBoth('{(.key): .value}', '{"key":"x","value":1}', ["-S"]);
    });
    it("object constructor dynamic key emits multiple objects", async () => {
      await compareBoth('{(.keys[]): .value}', '{"keys":["a","b"],"value":1}', ["-S"]);
    });
    it("object constructor dynamic key with multi value", async () => {
      await compareBoth('{(.key): (.a,.b)}', '{"key":"x","a":1,"b":2}', ["-S"]);
    });
    it("map({n: .name})", async () => {
      await compareFile(
        ".users | map({n: .name})",
        '{"users":[{"name":"a","age":1},{"name":"b","age":2}]}',
        ["-S"],
      );
    });
    it("map({n: .name, e: .email})", async () => {
      await compareFile(
        ".users | map({n: .name, e: .email})",
        '{"users":[{"name":"a","email":"a@x"},{"name":"b","email":"b@x"}]}',
        ["-S"],
      );
    });
    it("bare map({id: .id, t: .title}) at root", async () => {
      await compareFile(
        "map({id: .id, t: .title})",
        '[{"id":1,"title":"one"},{"id":2,"title":"two"}]',
        ["-S"],
      );
    });
    it("map({c: .profile.country}) (nested key)", async () => {
      await compareFile(
        ".users | map({c: .profile.country})",
        '{"users":[{"profile":{"country":"US"}},{"profile":{"country":"UK"}}]}',
        ["-S"],
      );
    });

    // -- Arithmetic in select predicates -----------------------------------

    it("select(.price * .qty > 1000)", async () => {
      await compareFile(
        ".[] | select(.price * .qty > 1000)",
        '[{"price":50,"qty":10},{"price":100,"qty":15},{"price":200,"qty":3}]',
        ["-S"],
      );
    });
    it("select with subtraction", async () => {
      await compareFile(
        ".[] | select(.end - .start > 10)",
        '[{"start":1,"end":15},{"start":5,"end":10},{"start":0,"end":20}]',
        ["-S"],
      );
    });
    it("select with modulo (even ids)", async () => {
      await compareFile(
        ".[] | select(.id % 2 == 0)",
        '[{"id":1},{"id":2},{"id":3},{"id":4}]',
      );
    });
    it("arithmetic stand-alone (Node fallback)", async () => {
      // .x + .y at top level is not pushed down (only valid inside select);
      // partial pushdown projects .x and .y separately, but our planner
      // doesn't handle that case yet — Node fallback.
      await compareStdin(".x + .y", '{"x":3,"y":4}');
    });

    // -- group_by ----------------------------------------------------------

    it("group_by(.dept) on numeric-ish keys (string)", async () => {
      await compareFile(
        ".users | group_by(.dept)",
        '{"users":[{"name":"a","dept":"eng"},{"name":"b","dept":"sales"},{"name":"c","dept":"eng"},{"name":"d","dept":"sales"},{"name":"e","dept":"eng"}]}',
        ["-S"],
      );
    });
    it("group_by(.priority) numeric keys", async () => {
      await compareFile(
        ".tasks | group_by(.priority)",
        '{"tasks":[{"id":1,"priority":2},{"id":2,"priority":1},{"id":3,"priority":2},{"id":4,"priority":1},{"id":5,"priority":3}]}',
        ["-S"],
      );
    });
    it("group_by on empty array", async () => {
      await compareFile(".items | group_by(.k)", '{"items":[]}');
    });

    // -- to_entries / from_entries / flatten -------------------------------

    it("to_entries on object", async () => {
      await compareFile(
        ". | to_entries",
        '{"a":1,"b":2,"c":3}',
        ["-S"],
      );
    });
    it("from_entries on array of {key, value}", async () => {
      await compareFile(
        ". | from_entries",
        '[{"key":"a","value":1},{"key":"b","value":2}]',
        ["-S"],
      );
    });
    it("to_entries | from_entries round-trip", async () => {
      await compareFile(
        ". | to_entries | from_entries",
        '{"x":10,"y":20}',
        ["-S"],
      );
    });
    it("flatten one level", async () => {
      await compareFile(
        ".items | flatten",
        '{"items":[[1,2],[3,4],[5]]}',
      );
    });
    it("flatten with mixed elements", async () => {
      await compareFile(
        ".items | flatten",
        '{"items":[1,[2,3],4,[5,[6,7]]]}',
      );
    });
    it("flatten on empty array", async () => {
      await compareFile(".items | flatten", '{"items":[]}');
    });

    // -- Negative slice bounds ----------------------------------------------

    it("slice .users[-2:]", async () => {
      await compareFile(".users[-2:]", '{"users":[10,20,30,40,50]}');
    });
    it("slice .users[:-1]", async () => {
      await compareFile(".users[:-1]", '{"users":[10,20,30,40,50]}');
    });
    it("slice .users[-3:-1]", async () => {
      await compareFile(".users[-3:-1]", '{"users":[10,20,30,40,50]}');
    });
    it("slice with bounds beyond length", async () => {
      await compareFile(".users[-99:99]", '{"users":[10,20,30]}');
    });

    // -- String functions ---------------------------------------------------

    it("ascii_downcase", async () => {
      await compareFile(".name | ascii_downcase", '{"name":"ALICE"}');
    });
    it("ascii_upcase", async () => {
      await compareFile(".name | ascii_upcase", '{"name":"bob"}');
    });
    it("tonumber on string", async () => {
      await compareFile(".count | tonumber", '{"count":"42"}');
    });
    it("tonumber on negative float string", async () => {
      await compareFile(".v | tonumber", '{"v":"-3.14"}');
    });
    it("tonumber on non-numeric falls back to Node (errors)", async () => {
      // Native jq errors with exit 5; pushdown returns NULL → Node fallback
      // produces the same error.
      const native = runNativeJq([".x | tonumber"], '{"x":"abc"}');
      await pgFs.writeFile("/d.json", '{"x":"abc"}');
      const ours = await bash.exec("jq '.x | tonumber' /d.json");
      expect(ours.exitCode).toBe(native.exitCode);
    });
    it("split", async () => {
      await compareFile(
        '.csv | split(",")',
        '{"csv":"a,b,c,d"}',
      );
    });
    it("join", async () => {
      await compareFile(
        '.tags | join(", ")',
        '{"tags":["one","two","three"]}',
      );
    });
    it("ltrimstr", async () => {
      await compareFile(
        '.path | ltrimstr("/usr/")',
        '{"path":"/usr/local/bin"}',
      );
    });
    it("ltrimstr (no match)", async () => {
      await compareFile(
        '.path | ltrimstr("/usr/")',
        '{"path":"/etc/hosts"}',
      );
    });
    it("rtrimstr", async () => {
      await compareFile(
        '.path | rtrimstr(".json")',
        '{"path":"data.json"}',
      );
    });
    it("sub", async () => {
      await compareFile(
        '.text | sub("[0-9]+"; "X")',
        '{"text":"abc123abc456"}',
      );
    });
    it("gsub", async () => {
      await compareFile(
        '.text | gsub("[0-9]+"; "X")',
        '{"text":"abc123abc456"}',
      );
    });
    it("tostring on number (Node fallback)", async () => {
      await compareFile(".n | tostring", '{"n":42}');
    });
    it("ascii_downcase on non-string falls back", async () => {
      // Pushdown SQL works only on strings; non-string input → SQL NULL →
      // Node fallback raises the proper jq error.
      const native = runNativeJq([".x | ascii_downcase"], '{"x":42}');
      await pgFs.writeFile("/d.json", '{"x":42}');
      const ours = await bash.exec("jq '.x | ascii_downcase' /d.json");
      expect(ours.exitCode).toBe(native.exitCode);
    });

    // -- paths / leaf_paths -------------------------------------------------

    it("paths on object", async () => {
      await compareFile(". | paths", '{"a":1,"b":[2,3]}');
    });
    it("paths on nested", async () => {
      await compareFile(
        ". | paths",
        '{"a":{"b":1},"c":[{"d":2},3]}',
      );
    });
    it("paths(predicate) by type", async () => {
      await compareFile(
        'paths(type == "number")',
        '{"a":1,"b":[2,"x"],"c":{"d":true}}',
      );
    });
    it("paths(predicate) by value", async () => {
      await compareFile(
        "paths(. == 2)",
        '{"a":1,"b":[2,"x"],"c":{"d":2}}',
      );
    });
    it("paths(predicate) can match containers", async () => {
      await compareFile(
        'paths(type == "array")',
        '[1,[2],{}]',
      );
    });
    // `leaf_paths` was removed from jq 1.8; we keep it in our evaluator for
    // compatibility but skip the parity test against the system jq.

    // -- flatten(N) --------------------------------------------------------

    it("flatten(1) on deep nest", async () => {
      await compareFile(
        ".items | flatten(1)",
        '{"items":[1,[2,[3,[4]]]]}',
      );
    });
    it("flatten(2) on deep nest", async () => {
      await compareFile(
        ".items | flatten(2)",
        '{"items":[1,[2,[3,[4]]]]}',
      );
    });
    it("flatten(0) returns input unchanged", async () => {
      await compareFile(
        ".items | flatten(0)",
        '{"items":[1,[2,3],4]}',
      );
    });

    // -- @csv / @tsv / @sh / @uri ------------------------------------------

    it("@csv on simple array", async () => {
      await compareFile("@csv", '[1,2,"a",true,null]');
    });
    it("@csv with quotes inside string", async () => {
      await compareFile('@csv', '["he said \\"hi\\"", 1]');
    });
    it("@tsv on simple array", async () => {
      await compareFile("@tsv", '[1,"a\\tb","c\\nd"]');
    });
    it("@sh on array of strings", async () => {
      await compareFile("@sh", `["hello world", "it's"]`);
    });
    it("@uri on string", async () => {
      await compareFile("@uri", '"hello world!"');
    });
    it("@uri on string with parens", async () => {
      await compareFile("@uri", '"a(b)c"');
    });
    it("@json", async () => {
      await compareFile("@json", '{"a":1}');
    });
    it("@base64 on string", async () => {
      await compareFile("@base64", '"hello world"');
    });
    it("@base64 round-trip", async () => {
      await compareFile("@base64 | @base64d", '"hello world"');
    });
    it("@base64 on object", async () => {
      await compareFile("@base64", '{"a":1}');
    });
    it("map | @csv pattern", async () => {
      await compareFile(
        ".rows | map(@csv)",
        '{"rows":[[1,"a"],[2,"b"],[3,"c"]]}',
      );
    });

    // -- String interpolation ----------------------------------------------

    it("string interpolation with field", async () => {
      await compareBoth('"hello \\(.name)"', '{"name":"Alice"}');
    });
    it("string interpolation renders arrays/objects compactly", async () => {
      await compareBoth('"obj=\\(.obj) arr=\\(.arr)"', '{"obj":{"a":1},"arr":[1,2]}');
    });
    it("string interpolation after iter", async () => {
      await compareBoth(
        '.items[] | "\\(.name)=\\(.value)"',
        '{"items":[{"name":"a","value":1},{"name":"b","value":2}]}',
      );
    });

    // -- Array constructors / comma ----------------------------------------

    it("array constructor with literals", async () => {
      await compareBoth("[1, 2, 3]", "{}");
    });
    it("array constructor with field projections", async () => {
      await compareBoth('[.id, .name]', '{"id":1,"name":"Alice"}');
    });
    it("array constructor collects iter output", async () => {
      await compareBoth('[.items[] | .name]', '{"items":[{"name":"a"},{"name":"b"}]}');
    });
    it("top-level comma emits multiple outputs", async () => {
      await compareBoth(".a, .b", '{"a":1,"b":2}');
    });
    it("array constructor enables @csv rows with interpolation", async () => {
      await compareBoth('[.id, "\\(.name)"] | @csv', '{"id":1,"name":"Alice"}');
    });

    // -- Assignment ---------------------------------------------------------

    it("update assignment |= on field", async () => {
      await compareBoth(".count |= . + 1", '{"count":41}');
    });
    it("update assignment creates missing nested objects", async () => {
      await compareBoth(".a.b |= 1", "{}", ["-S"]);
    });
    it("update assignment through array path", async () => {
      await compareBoth(
        ".items[1].name |= ascii_upcase",
        '{"items":[{"name":"alice"},{"name":"bob"}]}',
      );
    });
    it("update assignment empty deletes object key", async () => {
      await compareBoth(".a |= empty", '{"a":1,"b":2}', ["-S"]);
    });
    it("update assignment empty deletes array element", async () => {
      await compareBoth(".[1] |= empty", "[1,2,3]");
    });
    it("plain assignment emits once per RHS output", async () => {
      await compareBoth(".a = (1,2)", '{"a":0}', ["-c"]);
    });
    it("plus assignment with literal", async () => {
      await compareBoth(".count += 1", '{"count":41}');
    });
    it("plus assignment RHS uses root input", async () => {
      await compareBoth(".a += .b", '{"a":1,"b":2}', ["-S"]);
    });
    it("default assignment fills missing/null values", async () => {
      await compareBoth(".foo //= 0", "{}", ["-S"]);
      await compareBoth(".foo //= 0", '{"foo":null}', ["-S"]);
    });
    it("default assignment leaves truthy values unchanged", async () => {
      await compareBoth(".foo //= 0", '{"foo":5}', ["-S"]);
    });
    it("array assignment extends with nulls", async () => {
      await compareBoth(".[2] |= 9", "[]");
    });

    // -- Variables / dynamic indexing --------------------------------------

    it("variable binding preserves root input for body", async () => {
      await compareBoth('.a as $x | .b + $x', '{"a":1,"b":2}');
    });
    it("variable binding emits once per bound value", async () => {
      await compareBoth('(.a, .b) as $x | $x', '{"a":1,"b":2}');
    });
    it("variable shadowing", async () => {
      await compareBoth('.a as $x | .b as $x | $x', '{"a":1,"b":2}');
    });
    it("variable with postfix indexing", async () => {
      await compareBoth('[10,20,30] as $a | $a[1]', '{}');
    });
    it("dynamic string index from variable", async () => {
      await compareBoth('"foo" as $k | .[$k]', '{"foo":1}');
    });
    it("dynamic string index from expression", async () => {
      await compareBoth('.[.key]', '{"key":"foo","foo":7}');
    });
    it("dynamic numeric index from expression", async () => {
      await compareBoth('1 as $i | .[$i]', '[10,20,30]');
    });
    it("dynamic comma index emits multiple values", async () => {
      await compareBoth('.[1,2]', '[10,20,30]');
    });

    // -- Conditionals -------------------------------------------------------

    it("if then else true branch", async () => {
      await compareBoth('if .a then .b else .c end', '{"a":true,"b":1,"c":2}');
    });
    it("if then else false branch", async () => {
      await compareBoth('if .a then .b else .c end', '{"a":false,"b":1,"c":2}');
    });
    it("if with elif", async () => {
      await compareBoth('if .a then 1 elif .b then 2 else 3 end', '{"a":false,"b":true}');
    });
    it("if condition emits multiple values", async () => {
      await compareBoth('if (.a, .b) then . else empty end', '{"a":true,"b":false}');
    });
    it("if empty condition emits nothing", async () => {
      await compareBoth('if empty then 1 else 2 end', '{}');
    });

    // -- Search / path builtins --------------------------------------------

    it("contains on object", async () => {
      await compareBoth('contains({a: 1})', '{"a":1,"b":2}');
    });
    it("contains on array", async () => {
      await compareBoth('contains([2, 1])', '[1,2,3]');
    });
    it("inside", async () => {
      await compareBoth('inside({a: 1, b: 2})', '{"a":1}');
    });
    it("index / rindex on strings", async () => {
      await compareBoth('index("bc"), rindex("bc")', '"abcdabc"');
    });
    it("indices on strings", async () => {
      await compareBoth('indices("ab")', '"abcab"');
    });
    it("indices on arrays", async () => {
      await compareBoth('indices([1,2])', '[1,2,1,2,3]');
    });
    it("getpath", async () => {
      await compareBoth('getpath(["a",0,"b"])', '{"a":[{"b":2}]}');
    });
    it("setpath", async () => {
      await compareBoth('setpath(["a",1,"b"]; 3)', '{}', ["-S"]);
    });
    it("delpaths", async () => {
      await compareBoth('delpaths([["a"],["b",0]])', '{"a":1,"b":[2,3]}', ["-S"]);
    });
    it("del path", async () => {
      await compareBoth('del(.a.b)', '{"a":{"b":1,"c":2}}', ["-S"]);
    });

    // -- Regex extraction ---------------------------------------------------

    it("match", async () => {
      await compareBoth('match("a([0-9]+)")', '"xxa123yy"', ["-S"]);
    });
    it("capture named groups", async () => {
      await compareBoth('capture("(?<key>[a-z]+)=(?<value>[0-9]+)")', '"foo=123"', ["-S"]);
    });
    it("scan without captures", async () => {
      await compareBoth('scan("[0-9]+")', '"a12b34"');
    });
    it("scan with captures", async () => {
      await compareBoth('scan("([a-z])([0-9]+)")', '"a12b34"');
    });

    // -- Reduce -------------------------------------------------------------

    it("reduce sums values", async () => {
      await compareBoth('reduce .[] as $x (0; . + $x)', '[1,2,3]');
    });
    it("reduce builds arrays", async () => {
      await compareBoth('reduce .[] as $x ([]; . + [$x * 2])', '[1,2,3]');
    });
    it("reduce builds objects with dynamic assignment", async () => {
      await compareBoth(
        'reduce .items[] as $x ({}; .[$x.key] = $x.value)',
        '{"items":[{"key":"a","value":1},{"key":"b","value":2}]}',
        ["-S"],
      );
    });
    it("reduce over empty source returns init", async () => {
      await compareBoth('reduce empty as $x (0; . + $x)', '[1,2]');
    });

    // -- Foreach ------------------------------------------------------------

    it("foreach emits intermediate accumulators", async () => {
      await compareBoth('foreach .[] as $x (0; . + $x)', '[1,2,3]');
    });
    it("foreach supports extract expression", async () => {
      await compareBoth('foreach .[] as $x (0; . + $x; . * 10)', '[1,2,3]');
    });
    it("foreach over empty source emits nothing", async () => {
      await compareBoth('foreach empty as $x (0; . + $x; .)', '[1,2]');
    });
    it("foreach extract sees accumulator", async () => {
      await compareBoth('foreach .[] as $x ([]; . + [$x]; length)', '[1,2,3]');
    });

    // -- JSON / type filters / ranges --------------------------------------

    it("tojson and fromjson", async () => {
      await compareBoth('tojson | fromjson', '{"a":1}', ["-S"]);
    });
    it("type filters", async () => {
      await compareStdin('arrays, objects, numbers, strings, booleans, nulls, scalars', '[1,2]');
      await compareStdin('arrays, objects, numbers, strings, booleans, nulls, scalars', '{"a":1}');
      await compareStdin('arrays, objects, numbers, strings, booleans, nulls, scalars', '42');
      await compareStdin('arrays, objects, numbers, strings, booleans, nulls, scalars', '"x"');
      await compareStdin('arrays, objects, numbers, strings, booleans, nulls, scalars', 'true');
      await compareStdin('arrays, objects, numbers, strings, booleans, nulls, scalars', 'null');
    });
    it("range", async () => {
      await compareBoth('range(3)', 'null');
      await compareBoth('range(2; 7; 2)', 'null');
    });

    // -- Error control ------------------------------------------------------

    it("try catch returns fallback on error", async () => {
      await compareBoth('try (.x | tonumber) catch 0', '{"x":"abc"}');
    });
    it("catch body receives error message", async () => {
      await compareBoth('try (.x | tonumber) catch .', '{"x":"abc"}');
    });
    it("try catch empty filters bad values", async () => {
      await compareBoth('.items[] | try .x catch empty', '{"items":[{"x":1},2,{"x":3}]}');
    });
    it("optional expression suppresses errors", async () => {
      await compareBoth('.[] | tonumber?', '["1","x",2]');
    });
    it("fromjson? filters invalid JSON", async () => {
      await compareBoth('.[] | fromjson?', '["{\\"a\\":1}","not json"]', ["-S"]);
    });

    // -- CLI variables ------------------------------------------------------

    it("--arg provides string variable", async () => {
      await compareBoth('.[$k]', '{"foo":1}', ["--arg", "k", "foo"]);
    });
    it("--argjson provides JSON variable", async () => {
      await compareBoth('$x + .n', '{"n":2}', ["--argjson", "x", "40"]);
    });
    it("--arg works in partially pushed residual filters", async () => {
      await compareFile(
        '.users[] | select(.role == $role)',
        '{"users":[{"role":"admin"},{"role":"user"}]}',
        ["--arg", "role", "admin"],
      );
    });

    // -- with_entries / first / last / nth / limit ------------------------

    it("with_entries: double every value", async () => {
      // Body uses arithmetic + ObjectCons — falls back to Node since the
      // pipeline isn't a single pushdownable shape, but the desugar to
      // to_entries|map|from_entries verifies the parser rewrite works.
      await compareFile(
        ". | with_entries({key: .key, value: (.value * 2)})",
        '{"a":1,"b":2,"c":3}',
        ["-S"],
      );
    });
    it("first(.users[])", async () => {
      await compareFile(
        "first(.users[])",
        '{"users":[10,20,30]}',
        ["-S"],
      );
    });
    it("last(.users[])", async () => {
      await compareFile(
        "last(.users[])",
        '{"users":[10,20,30]}',
        ["-S"],
      );
    });
    it("nth(1; .users[])", async () => {
      await compareFile(
        "nth(1; .users[])",
        '{"users":[10,20,30,40]}',
        ["-S"],
      );
    });
    it("nth out of range", async () => {
      await compareFile("nth(99; .[])", "[1,2,3]");
    });
    it("limit(2; .users[])", async () => {
      await compareFile(
        "limit(2; .users[])",
        '{"users":[10,20,30,40,50]}',
      );
    });
    it("limit(0; ...)", async () => {
      await compareFile(
        "limit(0; .users[])",
        '{"users":[1,2,3]}',
      );
    });
    it("limit larger than array", async () => {
      await compareFile(
        "limit(99; .users[])",
        '{"users":[1,2,3]}',
      );
    });

    // -- User-defined functions ---------------------------------------------

    it("def: zero-arg function", async () => {
      await compareBoth("def double: . * 2; double", "21");
    });
    it("def: filter-typed argument applied to current input", async () => {
      await compareBoth("def add1(f): f + 1; add1(.)", "10");
    });
    it("def: filter-typed argument re-evaluated each reference", async () => {
      // f is invoked twice; if it iterates `.[]` it should run for each call.
      await compareBoth(
        "def pair(f): [f, f]; pair(.x)",
        '{"x":7}',
      );
    });
    it("def: value-typed $-param binds once at call site", async () => {
      await compareBoth("def add($n): . + $n; add(.x + 1)", '{"x":4}');
    });
    it("def: $-param captures call-site env", async () => {
      await compareBoth(
        "def use($v): $v * 2; 10 as $v | use($v + 1)",
        "null",
      );
    });
    it("def: recursion (factorial)", async () => {
      await compareBoth(
        "def fact: if . <= 1 then 1 else . * ((. - 1) | fact) end; fact",
        "5",
      );
    });
    it("def: inner def can call outer def", async () => {
      await compareBoth(
        "def outer: . + 1; def caller: outer; caller",
        "10",
      );
    });
    it("def: nested def shadows outer", async () => {
      await compareBoth(
        "def f: 1; def g: def f: 2; f; [f, g]",
        "null",
      );
    });
    it("def: multiple parameters", async () => {
      await compareBoth(
        "def between(lo; hi): . >= lo and . <= hi; "
          + "[range(0; 6) | select(between(2; 4))]",
        "null",
      );
    });
    it("def: filter-typed arg over array iteration", async () => {
      await compareBoth(
        "def doubled(f): [f] | map(. * 2); doubled(.[])",
        "[1,2,3]",
      );
    });
    it("def: --arg variable visible inside def body", async () => {
      // Value-typed arg from CLI should be visible in def body when threaded
      // through funcs/params.
      await compareBoth(
        "def role: $role; .users[] | select(.role == role)",
        '{"users":[{"role":"admin"},{"role":"user"}]}',
        ["--arg", "role", "admin"],
      );
    });
    it("def: closure over outer $-binding", async () => {
      await compareBoth(
        "10 as $base | def shift: . + $base; [.[] | shift]",
        "[1,2,3]",
      );
    });
    it("def: arity overloading by name (different param counts)", async () => {
      await compareBoth(
        "def f: 1; def f(x): x + 1; [f, f(10)]",
        "null",
      );
    });

    // -- Recursive descent ---------------------------------------------------

    it("recursive descent on file (values match, order may differ)", async () => {
      // jq's tree-walk pre-order vs Postgres's `$.**`: not byte-identical in
      // general, but the *set* of emitted values matches. Verify via sort.
      const content = '{"a":1,"b":[2,3]}';
      await pgFs.writeFile("/rd.json", content);
      const native = runNativeJq(["-c", ".."], content);
      const ours = await bash.exec("jq -c '..' /rd.json");
      expect(ours.exitCode).toBe(native.exitCode);
      const split = (s: string) => s.trim().split("\n").sort();
      expect(split(ours.stdout)).toEqual(split(native.stdout));
    });
  });

  // -- Pushdown verification -------------------------------------------------

  describe("pushdown is exercised on PgFileSystem files", () => {
    it("file + pushdownable filter → jsonb_path_query_array runs", async () => {
      const queries: string[] = [];
      const spyFs = new PgFileSystem({
        db: {
          query: (text, params) => {
            queries.push(text);
            return client.query(text, params);
          },
          transaction: (fn) => client.transaction(fn),
        },
        workspaceId: wsId,
      });
      await spyFs.init();
      const spyBash = new Bash({ fs: spyFs, customCommands: [jqCommand] });
      await spyFs.writeFile(
        "/big.json",
        JSON.stringify({ users: [{ name: "Alice" }, { name: "Bob" }] }),
      );
      queries.length = 0;
      const r = await spyBash.exec("jq '.users[1].name' /big.json");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('"Bob"\n');
      expect(queries.some((q) => q.includes("jsonb_path_query_array"))).toBe(
        true,
      );
    });

    it("file + un-pushdownable filter → uses readFile fallback", async () => {
      const queries: string[] = [];
      const spyFs = new PgFileSystem({
        db: {
          query: (text, params) => {
            queries.push(text);
            return client.query(text, params);
          },
          transaction: (fn) => client.transaction(fn),
        },
        workspaceId: wsId,
      });
      await spyFs.init();
      const spyBash = new Bash({ fs: spyFs, customCommands: [jqCommand] });
      await spyFs.writeFile(
        "/u.json",
        JSON.stringify({ a: { b: { c: 1 } } }),
      );
      queries.length = 0;
      // `length` at the root is refused as a trivial pushdown (no projection
      // benefit) — runs entirely via readFile + Node.
      const r = await spyBash.exec("jq 'length' /u.json");
      expect(r.exitCode).toBe(0);
      expect(queries.some((q) => q.includes("jsonb_path_query_array"))).toBe(
        false,
      );
    });

    it("file + Iter+select → pushes down with array check", async () => {
      const queries: string[] = [];
      const spyFs = new PgFileSystem({
        db: {
          query: (text, params) => {
            queries.push(text);
            return client.query(text, params);
          },
          transaction: (fn) => client.transaction(fn),
        },
        workspaceId: wsId,
      });
      await spyFs.init();
      const spyBash = new Bash({ fs: spyFs, customCommands: [jqCommand] });
      await spyFs.writeFile(
        "/u.json",
        JSON.stringify([{ age: 25 }, { age: 35 }]),
      );
      queries.length = 0;
      const r = await spyBash.exec("jq -c '.[] | select(.age > 30)' /u.json");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('{"age":35}\n');
      expect(queries.some((q) => q.includes("jsonb_path_query_array"))).toBe(
        true,
      );
    });

    it("file + .users | length uses SQL aggregate (jsonb_array_length)", async () => {
      const queries: { sql: string; params: unknown[] }[] = [];
      const spyFs = new PgFileSystem({
        db: {
          query: (text, params) => {
            queries.push({ sql: text, params: params ?? [] });
            return client.query(text, params);
          },
          transaction: (fn) => client.transaction(fn),
        },
        workspaceId: wsId,
      });
      await spyFs.init();
      const spyBash = new Bash({ fs: spyFs, customCommands: [jqCommand] });
      await spyFs.writeFile(
        "/u.json",
        JSON.stringify({
          users: [1, 2, 3, 4, 5],
          junk: "lots of unrelated content",
        }),
      );
      queries.length = 0;
      const r = await spyBash.exec("jq '.users | length' /u.json");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("5\n");
      expect(queries.some((q) => q.sql.includes("jsonb_array_length"))).toBe(
        true,
      );
      // No need to fetch the array via jsonb_path_query_array.
      expect(queries.some((q) => q.sql.includes("jsonb_path_query_array"))).toBe(
        false,
      );
    });

    it("file + .text | gsub uses SQL regexp_replace", async () => {
      const queries: { sql: string; params: unknown[] }[] = [];
      const spyFs = new PgFileSystem({
        db: {
          query: (text, params) => {
            queries.push({ sql: text, params: params ?? [] });
            return client.query(text, params);
          },
          transaction: (fn) => client.transaction(fn),
        },
        workspaceId: wsId,
      });
      await spyFs.init();
      const spyBash = new Bash({ fs: spyFs, customCommands: [jqCommand] });
      await spyFs.writeFile("/u.json", JSON.stringify({ text: "abc123def456" }));
      queries.length = 0;
      const r = await spyBash.exec("jq '.text | gsub(\"[0-9]+\"; \"X\")' /u.json");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('"abcXdefX"\n');
      expect(queries.some((q) => q.sql.includes("regexp_replace"))).toBe(true);
      expect(queries.some((q) => q.sql.includes("jsonb_path_query_array"))).toBe(
        false,
      );
    });

    it("file + partial pushdown (.users | keys) projects only .users", async () => {
      const queries: { sql: string; params: unknown[] }[] = [];
      const spyFs = new PgFileSystem({
        db: {
          query: (text, params) => {
            queries.push({ sql: text, params: params ?? [] });
            return client.query(text, params);
          },
          transaction: (fn) => client.transaction(fn),
        },
        workspaceId: wsId,
      });
      await spyFs.init();
      const spyBash = new Bash({ fs: spyFs, customCommands: [jqCommand] });
      await spyFs.writeFile(
        "/u.json",
        JSON.stringify({
          users: [1, 2, 3, 4, 5],
          junk: "lots of unrelated content",
        }),
      );
      queries.length = 0;
      const r = await spyBash.exec("jq -c '.users | keys' /u.json");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("[0,1,2,3,4]\n");
      const pushdown = queries.find((q) =>
        q.sql.includes("jsonb_path_query_array"),
      );
      expect(pushdown).toBeDefined();
      expect(pushdown?.params).toContain("$.users");
    });
  });

  // -- Edge inputs -----------------------------------------------------------

  describe("edge inputs", () => {
    it("empty array", async () => {
      await compareBoth(".[]", "[]");
    });
    it("empty object iter", async () => {
      await compareBoth(".[]", "{}");
    });
    it("multiple json docs concatenated", async () => {
      await compareStdin(".", '{"a":1}{"b":2}');
    });
    it("nested arrays of arrays", async () => {
      await compareBoth(".", "[[1,2],[3,4]]");
    });
  });
});
