import { describe, it, expect } from "vitest";
import { parseFilter } from "./parser.js";
import {
  planAggregate,
  planMapObject,
  planPushdown,
  planSlice,
  translateToJsonPath,
} from "./pushdown.js";

function trans(filter: string): string | null {
  return translateToJsonPath(parseFilter(filter));
}

function plan(filter: string) {
  return planPushdown(parseFilter(filter));
}

describe("translateToJsonPath (path-single only)", () => {
  it("identity → $", () => {
    expect(trans(".")).toBe("$");
  });

  it("simple field → $.foo", () => {
    expect(trans(".foo")).toBe("$.foo");
  });

  it("chained fields collapse into a single path", () => {
    expect(trans(".foo.bar.baz")).toBe("$.foo.bar.baz");
  });

  it("non-negative index → $[N]", () => {
    expect(trans(".[0]")).toBe("$[0]");
    expect(trans(".[7]")).toBe("$[7]");
  });

  it("field then index", () => {
    expect(trans(".items[2]")).toBe("$.items[2]");
  });

  it("quoted/special keys get jsonpath-quoted", () => {
    expect(trans('.["weird key"]')).toBe('$."weird key"');
  });

  it("pipe of pushdownable nodes collapses", () => {
    expect(trans(".foo | .bar")).toBe("$.foo.bar");
  });

  // -- now translatable through planPushdown but still NOT path-single ------

  it("iteration is not a single-path translation", () => {
    expect(trans(".[]")).toBeNull();
    expect(trans(".foo[]")).toBeNull();
  });

  it("recursive descent is not pushed down", () => {
    expect(trans("..")).toBeNull();
  });

  it("default (//) is not path-single", () => {
    expect(trans('.foo // "x"')).toBeNull();
  });
});

describe("planPushdown", () => {
  it("plans full path-single pushdown", () => {
    const p = plan(".foo.bar");
    expect(p).not.toBeNull();
    expect(p?.path).toBe("$.foo.bar");
    expect(p?.rest).toBeNull();
    expect(p?.pathSingle).toBe(true);
    expect(p?.arrayCheckPath).toBeUndefined();
  });

  it("translates negative indices via `last`", () => {
    expect(plan(".[-1]")?.path).toBe("$[last]");
    expect(plan(".[-2]")?.path).toBe("$[last - 1]");
    expect(plan(".items[-1]")?.path).toBe("$.items[last]");
  });

  it("plans Iter with array-check at the parent path", () => {
    const p = plan(".users[]");
    expect(p?.path).toBe("$.users[*]");
    expect(p?.arrayCheckPath).toEqual(["users"]);
    expect(p?.pathSingle).toBe(false);
    expect(p?.rest).toBeNull();
  });

  it("plans top-level Iter with empty array-check (root)", () => {
    const p = plan(".[]");
    expect(p?.path).toBe("$[*]");
    expect(p?.arrayCheckPath).toEqual([]);
  });

  it("plans Iter + select(<path> cmp <literal>)", () => {
    const p = plan(".[] | select(.age > 30)");
    expect(p?.path).toBe("$[*] ? (@.age > 30)");
    expect(p?.arrayCheckPath).toEqual([]);
    expect(p?.rest).toBeNull();
  });

  it("plans nested-field Iter + select", () => {
    const p = plan('.users[] | select(.role == "admin")');
    expect(p?.path).toBe('$.users[*] ? (@.role == "admin")');
    expect(p?.arrayCheckPath).toEqual(["users"]);
  });

  it("plans Iter + select + field projection", () => {
    const p = plan('.users[] | select(.age > 30) | .name');
    expect(p?.path).toBe("$.users[*] ? (@.age > 30).name");
    expect(p?.arrayCheckPath).toEqual(["users"]);
  });

  it("plans partial pushdown when suffix is non-translatable", () => {
    const p = plan(".users | length");
    expect(p?.path).toBe("$.users");
    expect(p?.rest).not.toBeNull();
    expect(p?.rest?.type).toBe("Builtin0");
  });

  it("partial pushdown stops at the first untranslatable node", () => {
    const p = plan(".a.b | type");
    expect(p?.path).toBe("$.a.b");
    expect(p?.rest?.type).toBe("Builtin0");
  });

  it("partial pushdown keeps the remaining pipe in `rest`", () => {
    const p = plan(".users[] | .name | length");
    // Iter is pushdownable, .name is too — but inside iter context the
    // Iter's pathSingle goes false; length still goes to rest.
    expect(p?.path).toBe("$.users[*].name");
    expect(p?.rest?.type).toBe("Builtin0");
  });

  it("returns null for trivial pushdowns (no benefit)", () => {
    // `length` on root: would push down identity (just fetch the document)
    // and run length in Node — same as readFile, so we refuse.
    expect(plan("length")).toBeNull();
  });

  it("default (//) becomes partial pushdown", () => {
    const p = plan('.foo // "x"');
    expect(p?.path).toBe("$.foo");
    expect(p?.rest?.type).toBe("Default");
  });

  it("select with `and` becomes a single jsonpath predicate", () => {
    const p = plan(".[] | select(.a > 0 and .b == 1)");
    expect(p?.path).toBe("$[*] ? ((@.a > 0) && (@.b == 1))");
    expect(p?.rest).toBeNull();
  });

  it("select with `or` and nested groups", () => {
    const p = plan('.[] | select(.role == "admin" or .role == "owner")');
    expect(p?.path).toBe(
      '$[*] ? ((@.role == "admin") || (@.role == "owner"))',
    );
  });

  it("select(has(\"k\")) → exists()", () => {
    const p = plan('.[] | select(has("email"))');
    expect(p?.path).toBe("$[*] ? (exists(@.email))");
  });

  it("select(.x) truthy check", () => {
    const p = plan(".[] | select(.deleted)");
    expect(p?.path).toBe("$[*] ? (@.deleted != null && @.deleted != false)");
  });

  it("recursive descent → $.**", () => {
    const p = plan("..");
    expect(p?.path).toBe("$.**");
    expect(p?.arrayCheckPath).toBeUndefined();
    expect(p?.pathSingle).toBe(false);
  });

  it("first → $[0]", () => {
    expect(plan(".users | first")?.path).toBe("$.users[0]");
  });

  it("last → $[last]", () => {
    expect(plan(".users | last")?.path).toBe("$.users[last]");
  });

  it("map(<path>) → [*]<body> with wrapResult", () => {
    const p = plan(".users | map(.name)");
    expect(p?.path).toBe("$.users[*].name");
    expect(p?.arrayCheckPath).toEqual(["users"]);
    expect(p?.wrapResult).toBe(true);
    expect(p?.rest).toBeNull();
  });

  it("map at root", () => {
    const p = plan("map(.x)");
    expect(p?.path).toBe("$[*].x");
    expect(p?.arrayCheckPath).toEqual([]);
    expect(p?.wrapResult).toBe(true);
  });

  it("map with non-translatable body falls back", () => {
    // body uses select() which is fine, but Select outside iter context
    // (the body is walked from a fresh state) doesn't translate.
    const p = plan("map(select(.x > 0))");
    expect(p).toBeNull();
  });
});

describe("planAggregate", () => {
  it("recognises .users | length", () => {
    expect(planAggregate(parseFilter(".users | length"))).toEqual({
      kind: "length",
      over: ["users"],
    });
  });

  it("recognises root | length", () => {
    expect(planAggregate(parseFilter(". | length"))).toEqual({
      kind: "length",
      over: [],
    });
  });

  it("recognises .scores | add", () => {
    expect(planAggregate(parseFilter(".scores | add"))).toEqual({
      kind: "sum",
      over: ["scores"],
    });
  });

  it("recognises .a.b | min", () => {
    expect(planAggregate(parseFilter(".a.b | min"))).toEqual({
      kind: "min",
      over: ["a", "b"],
    });
  });

  it("recognises .a.b | max", () => {
    expect(planAggregate(parseFilter(".a.b | max"))).toEqual({
      kind: "max",
      over: ["a", "b"],
    });
  });

  it("rejects mid-pipe builtins", () => {
    // length must be the *trailing* op; .x | length | type isn't an aggregate.
    expect(planAggregate(parseFilter(".x | length | type"))).toBeNull();
  });

  it("rejects non-pure-path lhs", () => {
    expect(planAggregate(parseFilter(".[] | length"))).toBeNull();
  });

  it("rejects unrelated builtins", () => {
    expect(planAggregate(parseFilter(".x | type"))).toBeNull();
    expect(planAggregate(parseFilter(".x | keys"))).toBeNull();
  });

  it("recognises string functions", () => {
    expect(planAggregate(parseFilter(".name | ascii_downcase"))).toEqual({
      kind: "ascii_downcase",
      over: ["name"],
    });
    expect(planAggregate(parseFilter(".name | ascii_upcase"))).toEqual({
      kind: "ascii_upcase",
      over: ["name"],
    });
    expect(planAggregate(parseFilter(".n | tonumber"))).toEqual({
      kind: "tonumber",
      over: ["n"],
    });
  });

  it("recognises string transforms with arg", () => {
    expect(planAggregate(parseFilter('.csv | split(",")'))).toEqual({
      kind: "split",
      over: ["csv"],
      stringArg: ",",
    });
    expect(planAggregate(parseFilter('.tags | join(",")'))).toEqual({
      kind: "join",
      over: ["tags"],
      stringArg: ",",
    });
    expect(planAggregate(parseFilter('.path | ltrimstr("/")'))).toEqual({
      kind: "ltrimstr",
      over: ["path"],
      stringArg: "/",
    });
    expect(planAggregate(parseFilter('.path | rtrimstr(".json")'))).toEqual({
      kind: "rtrimstr",
      over: ["path"],
      stringArg: ".json",
    });
    expect(planAggregate(parseFilter('.text | sub("[0-9]+"; "X")'))).toEqual({
      kind: "sub",
      over: ["text"],
      stringArg: "[0-9]+",
      replacementArg: "X",
    });
    expect(planAggregate(parseFilter('.text | gsub("[0-9]+"; "X")'))).toEqual({
      kind: "gsub",
      over: ["text"],
      stringArg: "[0-9]+",
      replacementArg: "X",
    });
  });

  it("rejects regex replacement pushdown with backslash replacement", () => {
    expect(planAggregate(parseFilter('.text | gsub("x"; "\\\\")'))).toBeNull();
  });

  it("recognises sort / unique / reverse", () => {
    expect(planAggregate(parseFilter(".items | sort"))).toEqual({
      kind: "sort",
      over: ["items"],
    });
    expect(planAggregate(parseFilter(".items | unique"))).toEqual({
      kind: "unique",
      over: ["items"],
    });
    expect(planAggregate(parseFilter(".items | reverse"))).toEqual({
      kind: "reverse",
      over: ["items"],
    });
  });

  it("recognises group_by with key path", () => {
    expect(planAggregate(parseFilter(".users | group_by(.dept)"))).toEqual({
      kind: "group_by",
      over: ["users"],
      keyPath: ["dept"],
    });
  });

  it("recognises sort_by / min_by / max_by with key path", () => {
    expect(planAggregate(parseFilter(".users | sort_by(.age)"))).toEqual({
      kind: "sort_by",
      over: ["users"],
      keyPath: ["age"],
    });
    expect(planAggregate(parseFilter(".users | min_by(.score)"))).toEqual({
      kind: "min_by",
      over: ["users"],
      keyPath: ["score"],
    });
    expect(planAggregate(parseFilter(".items | max_by(.user.id)"))).toEqual({
      kind: "max_by",
      over: ["items"],
      keyPath: ["user", "id"],
    });
  });

  it("rejects sort_by with non-pure-path key", () => {
    // .x[] (iter inside the key) isn't a pure path → planAggregate refuses.
    expect(planAggregate(parseFilter(".users | sort_by(.x[])"))).toBeNull();
    // length on the key isn't a pure path either.
    expect(planAggregate(parseFilter(".users | sort_by(length)"))).toBeNull();
  });
});

describe("planMapObject", () => {
  it("recognises .users | map({n: .name, e: .email})", () => {
    expect(
      planMapObject(parseFilter(".users | map({n: .name, e: .email})")),
    ).toEqual({
      over: ["users"],
      pairs: [
        { key: "n", valuePath: ["name"] },
        { key: "e", valuePath: ["email"] },
      ],
    });
  });

  it("recognises bare map({...}) at root", () => {
    expect(planMapObject(parseFilter('map({id: .id, t: .title})'))).toEqual({
      over: [],
      pairs: [
        { key: "id", valuePath: ["id"] },
        { key: "t", valuePath: ["title"] },
      ],
    });
  });

  it("supports nested key paths", () => {
    expect(
      planMapObject(parseFilter(".users | map({c: .profile.country})")),
    ).toEqual({
      over: ["users"],
      pairs: [{ key: "c", valuePath: ["profile", "country"] }],
    });
  });

  it("rejects non-pure-path values", () => {
    expect(planMapObject(parseFilter("map({x: length})"))).toBeNull();
    expect(planMapObject(parseFilter("map({x: .[]})"))).toBeNull();
  });
});

describe("planSlice", () => {
  it("recognises .users[1:3]", () => {
    expect(planSlice(parseFilter(".users[1:3]"))).toEqual({
      over: ["users"],
      start: 1,
      end: 3,
    });
  });

  it("recognises .[2:5] (root slice)", () => {
    expect(planSlice(parseFilter(".[2:5]"))).toEqual({
      over: [],
      start: 2,
      end: 5,
    });
  });

  it("supports open-ended bounds", () => {
    expect(planSlice(parseFilter(".items[5:]"))?.end).toBeNull();
    expect(planSlice(parseFilter(".items[:5]"))?.start).toBeNull();
  });

  it("accepts negative bounds (resolved in SQL)", () => {
    expect(planSlice(parseFilter(".items[-2:]"))).toEqual({
      over: ["items"],
      start: -2,
      end: null,
    });
    expect(planSlice(parseFilter(".items[:-1]"))).toEqual({
      over: ["items"],
      start: null,
      end: -1,
    });
  });
});

describe("string predicates in select", () => {
  it("startswith → jsonpath `starts with`", () => {
    const p = plan('.[] | select(.name | startswith("A"))');
    expect(p?.path).toBe('$[*] ? (@.name starts with "A")');
  });

  it("endswith → jsonpath like_regex with $", () => {
    const p = plan('.[] | select(.path | endswith(".json"))');
    expect(p?.path).toBe(
      '$[*] ? (@.path like_regex "\\\\.json$")',
    );
  });

  it("test → jsonpath like_regex", () => {
    const p = plan('.[] | select(.email | test("^a.*@"))');
    expect(p?.path).toBe('$[*] ? (@.email like_regex "^a.*@")');
  });
});

describe("arithmetic in select predicates", () => {
  it("multiplication", () => {
    const p = plan(".[] | select(.price * .qty > 1000)");
    expect(p?.path).toBe("$[*] ? ((@.price * @.qty) > 1000)");
  });

  it("addition with literal", () => {
    const p = plan(".[] | select(.x + 1 == .y)");
    expect(p?.path).toBe("$[*] ? ((@.x + 1) == @.y)");
  });

  it("nested arithmetic", () => {
    const p = plan(".[] | select((.a + .b) * 2 > .c)");
    expect(p?.path).toBe("$[*] ? (((@.a + @.b) * 2) > @.c)");
  });

  it("modulo", () => {
    const p = plan(".[] | select(.n % 2 == 0)");
    expect(p?.path).toBe("$[*] ? ((@.n % 2) == 0)");
  });
});
