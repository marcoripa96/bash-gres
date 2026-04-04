import { describe, it, expect } from "vitest";
import {
  encodeLabel,
  decodeLabel,
  normalizePath,
  pathToLtree,
  ltreeToPath,
} from "../src/core/path-encoding.js";

describe("encodeLabel", () => {
  it("passes through alphanumeric and hyphens", () => {
    expect(encodeLabel("hello-world")).toBe("hello-world");
  });

  it("encodes dots", () => {
    expect(encodeLabel("file.txt")).toBe("file_x2E_txt");
  });

  it("encodes spaces", () => {
    expect(encodeLabel("my file")).toBe("my_x20_file");
  });

  it("encodes underscores", () => {
    expect(encodeLabel("my_file")).toBe("my_x5F_file");
  });

  it("encodes special characters", () => {
    expect(encodeLabel("hello@world!")).toBe("hello_x40_world_x21_");
  });

  it("rejects empty strings", () => {
    expect(() => encodeLabel("")).toThrow("Cannot encode empty filename");
  });

  it("rejects null bytes", () => {
    expect(() => encodeLabel("hello\0")).toThrow("null bytes");
  });
});

describe("decodeLabel", () => {
  it("decodes encoded dots", () => {
    expect(decodeLabel("file_x2E_txt")).toBe("file.txt");
  });

  it("decodes encoded spaces", () => {
    expect(decodeLabel("my_x20_file")).toBe("my file");
  });

  it("decodes encoded underscores", () => {
    expect(decodeLabel("my_x5F_file")).toBe("my_file");
  });

  it("round-trips with encodeLabel", () => {
    const names = ["file.txt", "my file.md", "hello_world", "special@#$.ts"];
    for (const name of names) {
      expect(decodeLabel(encodeLabel(name))).toBe(name);
    }
  });
});

describe("normalizePath", () => {
  it("normalizes root", () => {
    expect(normalizePath("/")).toBe("/");
  });

  it("removes trailing slashes", () => {
    expect(normalizePath("/foo/bar/")).toBe("/foo/bar");
  });

  it("resolves . segments", () => {
    expect(normalizePath("/foo/./bar")).toBe("/foo/bar");
  });

  it("resolves .. segments", () => {
    expect(normalizePath("/foo/bar/../baz")).toBe("/foo/baz");
  });

  it("resolves .. at root", () => {
    expect(normalizePath("/foo/../../bar")).toBe("/bar");
  });

  it("rejects null bytes", () => {
    expect(() => normalizePath("/foo\0bar")).toThrow("null bytes");
  });
});

describe("pathToLtree / ltreeToPath", () => {
  it("converts root path", () => {
    const ltree = pathToLtree("/", "session1");
    expect(ltree).toBe("s_session1");
    expect(ltreeToPath(ltree)).toBe("/");
  });

  it("converts single-level path", () => {
    const ltree = pathToLtree("/docs", "s1");
    expect(ltreeToPath(ltree)).toBe("/docs");
  });

  it("converts nested path with special chars", () => {
    const ltree = pathToLtree("/docs/readme.md", "s1");
    expect(ltreeToPath(ltree)).toBe("/docs/readme.md");
  });

  it("round-trips complex paths", () => {
    const paths = ["/", "/a", "/a/b/c", "/docs/my file.txt", "/src/index.ts"];
    for (const path of paths) {
      expect(ltreeToPath(pathToLtree(path, "test"))).toBe(path);
    }
  });
});
